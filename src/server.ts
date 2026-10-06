import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { loadHttpOptionsFromEnv } from "./transport-config.js";

export { createMcpServer, type ExistingToolHandlers } from "./mcp-server.js";
export { createRuntime, type InstagramRuntime, type RuntimeOptions } from "./runtime.js";

export function createServer(options: RuntimeOptions = {}) {
  return createRuntime(options).createMcpServer();
}

async function main(): Promise<void> {
  const runtime = createRuntime();
  await runtime.initialize();
  if (process.env.INSTAGRAM_MCP_TRANSPORT === "http") {
    const options = loadHttpOptionsFromEnv();
    const listener = await runtime.startHttpServer(options);
    console.error(`meta-instagram-mcp HTTP transport listening on ${options.host}:${options.port}`);
    const shutdown = () => { void listener.close().finally(() => process.exit(0)); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  const transport = new StdioServerTransport();
  await runtime.createMcpServer().connect(transport);
  console.error("meta-instagram-mcp running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "server startup failed");
    process.exit(1);
  });
}
