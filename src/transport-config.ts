import { isIP } from "node:net";
import type { HttpOptions } from "./http-server.js";

export interface HttpConfigInput {
  host?: string;
  port?: number;
  bearerSecret?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  maxRequestBytes?: number;
}

export function createNoRedirectFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(input, { ...init, redirect: "error" })) as typeof fetch;
}

export function createHttpOptions(input: HttpConfigInput): HttpOptions {
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? 8787;
  const bearerSecret = input.bearerSecret ?? "";
  if (host !== "127.0.0.1") throw new Error("HTTP listener must bind to 127.0.0.1");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid HTTP port");
  if (Buffer.byteLength(bearerSecret) < 32) throw new Error("HTTP bearer secret must be at least 32 bytes");
  const allowedHosts = input.allowedHosts ?? [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedOrigins = input.allowedOrigins ?? [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  for (const value of allowedHosts) if (!validHost(value)) throw new Error("invalid allowed Host entry");
  const normalizedOrigins = allowedOrigins.map((value) => {
    try {
      if (value.includes("*")) throw new Error();
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new Error("invalid allowed Origin entry"); }
  });
  const maxRequestBytes = input.maxRequestBytes ?? 1_048_576;
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1_024 || maxRequestBytes > 8_388_608) throw new Error("invalid HTTP request size limit");
  return { host, port, bearerSecret, allowedHosts: [...new Set(allowedHosts.map((value) => value.toLowerCase()))], allowedOrigins: [...new Set(normalizedOrigins)], maxRequestBytes };
}

export function loadHttpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const rawPort = env.INSTAGRAM_MCP_HTTP_PORT;
  return createHttpOptions({
    host: env.INSTAGRAM_MCP_HTTP_HOST ?? "127.0.0.1",
    port: rawPort === undefined ? undefined : Number(rawPort),
    bearerSecret: env.INSTAGRAM_MCP_HTTP_BEARER_TOKEN,
    allowedHosts: env.INSTAGRAM_MCP_HTTP_ALLOWED_HOSTS?.split(",").map((value) => value.trim()).filter(Boolean),
    allowedOrigins: env.INSTAGRAM_MCP_HTTP_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean),
    maxRequestBytes: env.INSTAGRAM_MCP_HTTP_MAX_REQUEST_BYTES === undefined ? undefined : Number(env.INSTAGRAM_MCP_HTTP_MAX_REQUEST_BYTES)
  });
}

function validHost(value: string): boolean {
  if (typeof value !== "string" || value.length > 255 || /[\s/@?#]/.test(value) || value.includes("*")) return false;
  try {
    const url = new URL(`http://${value}`);
    return !url.username && !url.password && url.pathname === "/" && url.search === "" && url.hash === "" && url.host.toLowerCase() === value.toLowerCase();
  } catch { return false; }
}

export function isLoopbackHost(host: string): boolean {
  const parsed = host.replace(/^\[|\]$/g, "");
  return parsed === "localhost" || parsed === "::1" || (isIP(parsed) === 4 && parsed.startsWith("127."));
}
