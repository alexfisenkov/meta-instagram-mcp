import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRemoteProxyServer, createRemoteProxyTransport, loadRemoteProxyConfig, startRemoteProxy } from "../src/cli/remote-proxy.js";

describe("remote-proxy", () => {
  it("loads a private external remote config and rejects an invalid remote route without local fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-remote-config-"));
    const configPath = join(directory, "remote.json");
    const config = { url: "https://mcp.example.test", bearerToken: "remote-proxy-fixture-token-0123456789" };
    try {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      expect(await loadRemoteProxyConfig({ INSTAGRAM_MCP_REMOTE_CONFIG: configPath })).toEqual(config);
      await expect(startRemoteProxy({ INSTAGRAM_MCP_REMOTE_URL: "http://mcp.example.test", INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: config.bearerToken }))
        .rejects.toThrow(/HTTPS origin/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards upstream schemas, annotations, and tool results over stdio MCP", async () => {
    const sourceTool = {
      name: "meta_get_account_info", description: "account info",
      inputSchema: { type: "object", properties: { userId: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, title: "Account" }
    };
    const upstream = {
      async listTools() { return { tools: [sourceTool] }; },
      async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ name: params.name, args: params.arguments }) }], structuredContent: { ok: true } };
      }
    };
    const server = createRemoteProxyServer(upstream);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-proxy-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools[0]).toMatchObject(sourceTool);
      expect(await client.callTool({ name: sourceTool.name, arguments: { userId: "42" } })).toMatchObject({
        structuredContent: { ok: true }, content: [{ type: "text", text: JSON.stringify({ name: sourceTool.name, args: { userId: "42" } }) }]
      });
    } finally { await client.close(); await server.close(); }
  });

  it("rejects a remote-proxy 307 before the second origin receives the credentialed request", async () => {
    let sinkRequests = 0;
    const sink = createServer((_request, response) => { sinkRequests += 1; response.end("captured"); });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as { port: number }).port;
    const redirect = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/capture` });
      response.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirect.address() as { port: number }).port;
    const transport = createRemoteProxyTransport(new URL(`http://127.0.0.1:${redirectPort}/mcp`), "p".repeat(40));
    const client = new Client({ name: "remote-proxy-redirect-test", version: "1.0.0" });
    try {
      await expect(client.connect(transport)).rejects.toThrow();
      expect(sinkRequests).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      await Promise.all([redirect, sink].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });
});
