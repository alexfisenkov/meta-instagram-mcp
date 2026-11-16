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
  const bridgeFlag = process.env.INSTAGRAM_MCP_BROWSER_BRIDGE;
  if (bridgeFlag !== undefined && bridgeFlag !== "" && bridgeFlag !== "true" && bridgeFlag !== "false") throw new Error("BROWSER_BRIDGE_FLAG_INVALID");
  if (bridgeFlag === "true" && process.env.INSTAGRAM_MCP_TRANSPORT && process.env.INSTAGRAM_MCP_TRANSPORT !== "stdio") throw new Error("BROWSER_BRIDGE_TRANSPORT_CONFLICT");
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
  const listener = bridgeFlag === "true" ? await runtime.startHttpServer({ ...loadHttpOptionsFromEnv(), browserBridgeOnly: true }) : undefined;
  const transport = new StdioServerTransport();
  const server = runtime.createMcpServer();
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([server.close(), ...(listener ? [listener.close()] : [])]).then((results) => {
      process.exit(results.some((result) => result.status === "rejected") ? 1 : 0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  server.server.onclose = shutdown;
  try { await server.connect(transport); }
  catch (error) { await listener?.close().catch(() => undefined); throw error; }
  console.error(listener ? "meta-instagram-mcp running on stdio with a private loopback browser bridge" : "meta-instagram-mcp running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : error.name) : "server startup failed");
    process.exit(1);
  });
}
