import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "./mcp-server.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { CompanionHub } from "./companion-hub.js";
import { startHttpServer } from "./http-server.js";
import { loadHttpOptionsFromEnv } from "./transport-config.js";

export { createMcpServer, type ExistingToolHandlers } from "./mcp-server.js";

export function createServer() {
  return createMcpServer();
}

async function main(): Promise<void> {
  if (process.env.INSTAGRAM_MCP_TRANSPORT === "http") {
    const options = loadHttpOptionsFromEnv();
    const hubPath = process.env.INSTAGRAM_MCP_HUB_STATE_PATH ?? join(homedir(), ".config", "meta-instagram-mcp", "companion-hub.json");
    const listener = await startHttpServer({ ...options, hub: new CompanionHub({ storagePath: hubPath }) });
    console.error(`meta-instagram-mcp HTTP transport listening on ${options.host}:${options.port}`);
    const shutdown = () => { void listener.close().finally(() => process.exit(0)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  console.error("meta-instagram-mcp running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "server startup failed");
    process.exit(1);
  });
}
