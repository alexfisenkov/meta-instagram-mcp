import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ExistingToolHandlers } from "../src/mcp-server.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function fixtureHandlers(): ExistingToolHandlers {
  return new Proxy({ scopePresets: () => [{ id: "stdio-fixture" }] }, {
    get(target, property) { return Reflect.get(target, property) ?? (async () => ({ ok: true })); }
  }) as unknown as ExistingToolHandlers;
}

describe("stdio factory compatibility", () => {
  it("keeps the legacy tool set available over the stdio server transport contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-stdio-fixture-")); dirs.push(dir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-regression", version: "1.0.0" });
    const server = createServer({ existingHandlers: fixtureHandlers(), providers: [], mutationExecutors: [],
      config: { authMode: "instagram", graphApiVersion: "v25.0", tokenStorePath: join(dir, "token.json"), publishLogPath: join(dir, "publish.jsonl") },
      hubStoragePath: join(dir, "hub.json"), approvalKeyPath: join(dir, "approval-key.json"),
      auditPath: join(dir, "mutation-audit.jsonl"), readbackPath: join(dir, "mutation-readback.json") });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(27);
      expect(tools.tools.map((tool) => tool.name)).toContain("meta_triage_inbox");
      expect(tools.tools.map((tool) => tool.name)).toContain("meta_reconcile_action");
      const result = await client.callTool({ name: "meta_scope_presets", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain("stdio-fixture");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
