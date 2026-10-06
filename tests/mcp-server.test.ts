import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ExistingToolHandlers } from "../src/mcp-server.js";
import { createLayeredToolHandlers } from "../src/layered-tools.js";
import { createSourceRouter } from "../src/source-router.js";

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
      expect(client.getServerVersion()).toMatchObject({ name: "meta-instagram-mcp", version: "0.2.0" });
      expect((await client.listTools()).tools).toHaveLength(18);
      const result = await client.callTool({ name: "meta_scope_presets", arguments: {} });
      expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify([{ id: "injected" }], null, 2) }] });
    } finally { await client.close(); await server.close(); }
  });

  it("adds layered tools only when the composed runtime supplies their handlers", async () => {
    const handlers = new Proxy({ scopePresets: () => [] }, {
      get(target, property) { return Reflect.get(target, property) ?? (async () => ({ ok: true })); }
    }) as unknown as ExistingToolHandlers;
    const layered = createLayeredToolHandlers({ router: createSourceRouter({ providers: [] }) });
    const server = createMcpServer(handlers, layered);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "layered-mcp-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toHaveLength(23);
      expect(names).toContain("meta_triage_inbox");
      expect(names).toContain("meta_analyze_inbox");
      const result = await client.callTool({ name: "meta_triage_inbox", arguments: { source: "auto", limit: 5 } });
      const content = (result as { content?: Array<{ text?: string }> }).content;
      expect(JSON.parse(content?.[0]?.text ?? "{}")).toMatchObject({ items: [], coverage: "unknown", truncated: true });
    } finally { await client.close(); await server.close(); }
  });
});
