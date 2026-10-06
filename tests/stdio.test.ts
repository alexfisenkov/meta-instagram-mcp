import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

describe("stdio factory compatibility", () => {
  it("keeps the legacy tool set available over the stdio server transport contract", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-regression", version: "1.0.0" });
    const server = createServer();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(18);
      const result = await client.callTool({ name: "meta_scope_presets", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
