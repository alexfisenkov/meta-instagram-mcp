import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRemoteProxyServer, createRemoteProxyTransport, loadRemoteProxyConfig, normalizeRemoteMcpEndpoint, startRemoteProxy } from "../src/cli/remote-proxy.js";
import { ensurePrivateFile } from "../src/private-fs.js";

describe("remote-proxy", () => {
  it("loads a private external remote config and rejects an invalid remote route without local fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-remote-config-"));
    const configPath = join(directory, "remote.json");
    const config = { url: "https://mcp.example.test/mcp", bearerToken: "remote-proxy-fixture-token-0123456789" };
    try {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await ensurePrivateFile(configPath);
      expect(await loadRemoteProxyConfig({ INSTAGRAM_MCP_REMOTE_CONFIG: configPath })).toEqual(config);
      await expect(startRemoteProxy({ INSTAGRAM_MCP_REMOTE_URL: "http://mcp.example.test", INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: config.bearerToken }))
        .rejects.toThrow(/HTTPS MCP endpoint/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the legacy HTTPS origin route and accepts an explicit isolated MCP path", async () => {
    const bearerToken = "remote-proxy-fixture-token-0123456789";
    await expect(loadRemoteProxyConfig({ INSTAGRAM_MCP_REMOTE_URL: "https://mcp.example.test", INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: bearerToken }))
      .resolves.toMatchObject({ url: "https://mcp.example.test/mcp", bearerToken });
    await expect(loadRemoteProxyConfig({ INSTAGRAM_MCP_REMOTE_URL: "https://mcp.example.test/instagram-client-b/mcp", INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: bearerToken }))
      .resolves.toMatchObject({ url: "https://mcp.example.test/instagram-client-b/mcp", bearerToken });
  });

  it.each([
    "https://user:pass@mcp.example.test/tenant/mcp",
    "https://mcp.example.test/tenant/../mcp",
    "https://mcp.example.test/tenant/%2e%2e/mcp",
    "https://mcp.example.test/tenant/mcp?key=value",
    "https://mcp.example.test/tenant/mcp#fragment",
    "https://mcp.example.test/tenant/not-mcp",
  ])("rejects unsafe explicit MCP endpoint %s", async (url) => {
    await expect(loadRemoteProxyConfig({ INSTAGRAM_MCP_REMOTE_URL: url, INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: "r".repeat(40) }))
      .rejects.toThrow(/HTTPS MCP endpoint/);
  });

  it("keeps endpoint, bearer, and MCP session state isolated for two configured remote cores", async () => {
    const requests: Array<{ url: string; authorization: string | null; session: string | null }> = [];
    const makeFetch = (sessionId: string) => async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        session: request.headers.get("mcp-session-id"),
      });
      const payload = JSON.parse(await request.text()) as { id?: string | number; method?: string; params?: { protocolVersion?: string } };
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { "mcp-session-id": sessionId } });
      }
      const result = payload.method === "initialize"
        ? { protocolVersion: payload.params?.protocolVersion ?? "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
        status: 200, headers: { "content-type": "application/json", "mcp-session-id": sessionId },
      });
    };
    const first = new Client({ name: "first-core", version: "1" });
    const second = new Client({ name: "second-core", version: "1" });
    try {
      await first.connect(createRemoteProxyTransport(normalizeRemoteMcpEndpoint("https://mcp.example.test/instagram-first/mcp"), "a".repeat(40), makeFetch("session-first")));
      await second.connect(createRemoteProxyTransport(normalizeRemoteMcpEndpoint("https://mcp.example.test/instagram-second/mcp"), "b".repeat(40), makeFetch("session-second")));
      await Promise.all([first.listTools(), second.listTools()]);

      expect(requests.length).toBeGreaterThanOrEqual(4);
      const firstRequests = requests.filter((request) => request.url.includes("/instagram-first/mcp"));
      const secondRequests = requests.filter((request) => request.url.includes("/instagram-second/mcp"));
      expect(firstRequests.every((request) => request.authorization === `Bearer ${"a".repeat(40)}` &&
        (request.session === null || request.session === "session-first"))).toBe(true);
      expect(secondRequests.every((request) => request.authorization === `Bearer ${"b".repeat(40)}` &&
        (request.session === null || request.session === "session-second"))).toBe(true);
      expect(firstRequests.some((request) => request.session === "session-first")).toBe(true);
      expect(secondRequests.some((request) => request.session === "session-second")).toBe(true);
    } finally {
      await Promise.all([first.close(), second.close()]);
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
