import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createNoRedirectFetch } from "../transport-config.js";
import { assertOutsideDirectory, assertPrivateFile } from "../private-fs.js";

export interface RemoteProxyConfig { url: string; bearerToken: string }
export interface RemoteClientPort {
  listTools(): Promise<{ tools: unknown[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
}

export function createRemoteProxyTransport(url: URL, bearerToken: string, fetchImpl: typeof fetch = fetch): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
    fetch: createNoRedirectFetch(fetchImpl)
  });
}

export function createRemoteProxyServer(upstream: RemoteClientPort): Server {
  const server = new Server({ name: "meta-instagram-remote-proxy", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => await upstream.listTools() as never);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try { return await upstream.callTool(request.params); }
    catch { return { content: [{ type: "text", text: "Remote tool request failed" }], isError: true }; }
  });
  return server;
}

export async function loadRemoteProxyConfig(env: NodeJS.ProcessEnv = process.env): Promise<RemoteProxyConfig> {
  let config: RemoteProxyConfig;
  const path = env.INSTAGRAM_MCP_REMOTE_CONFIG;
  if (path) {
    if (!isAbsolute(path)) throw new Error("remote proxy config path must be absolute");
    const resolved = resolve(path);
    assertOutsideDirectory(resolve(process.cwd()), resolved, "remote proxy config must be outside the project");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("remote proxy config must be a private regular file");
    await assertPrivateFile(resolved);
    config = JSON.parse(await readFile(resolved, "utf8")) as RemoteProxyConfig;
  } else {
    config = { url: env.INSTAGRAM_MCP_REMOTE_URL ?? "", bearerToken: env.INSTAGRAM_MCP_REMOTE_BEARER_TOKEN ?? "" };
  }
  const url = new URL(config.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("remote URL must be an HTTPS origin");
  if (typeof config.bearerToken !== "string" || Buffer.byteLength(config.bearerToken) < 32) throw new Error("remote bearer token is invalid");
  return config;
}

async function main(): Promise<void> {
  const config = await loadRemoteProxyConfig();
  const clientTransport = createRemoteProxyTransport(new URL("/mcp", config.url), config.bearerToken);
  const upstream = new Client({ name: "meta-instagram-remote-proxy", version: "0.1.0" });
  await upstream.connect(clientTransport);
  const proxyClient: RemoteClientPort = {
    listTools: () => upstream.listTools(),
    callTool: async (params) => await upstream.callTool(params) as CallToolResult
  };
  const server = createRemoteProxyServer(proxyClient);
  await server.connect(new StdioServerTransport());
  process.stderr.write("meta-instagram remote proxy connected\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`remote proxy failed: ${error instanceof Error ? error.name : "unknown error"}\n`);
    process.exit(1);
  });
}
