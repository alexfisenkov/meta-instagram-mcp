import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ExistingToolHandlers } from "../src/mcp-server.js";

describe("shared MCP factory", () => {
  it("injects existing handlers and registers the full legacy tool surface once", async () => {
    const handlers = new Proxy({ scopePresets: () => [{ id: "injected" }] }, {
      get(target, property) { return Reflect.get(target, property) ?? (async () => ({ ok: true })); }
    }) as unknown as ExistingToolHandlers;
    const server = createMcpServer(handlers);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-factory-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools).toHaveLength(18);
      const result = await client.callTool({ name: "meta_scope_presets", arguments: {} });
      expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify([{ id: "injected" }], null, 2) }] });
    } finally { await client.close(); await server.close(); }
  });
});
