import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, redactToken } from "./config.js";
import { buildAuthUrl, exchangeCodeForLongLivedToken } from "./oauth.js";
import { saveStoredToken } from "./token-store.js";

export type ParsedCallback =
  | { type: "code"; code: string }
  | { type: "error"; error: string; reason?: string; description?: string }
  | { type: "ignored" };

export type CallbackHtmlModel =
  | { type: "success"; title: string; details: Record<string, unknown> }
  | { type: "error"; title: string; details: Record<string, unknown> };

export function parseCallbackRequest(requestUrl: string, expectedPath: string): ParsedCallback {
  const url = new URL(requestUrl);
  if (url.pathname !== expectedPath) return { type: "ignored" };

  const error = url.searchParams.get("error");
  if (error) {
    return {
      type: "error",
      error,
      reason: url.searchParams.get("error_reason") ?? undefined,
      description: url.searchParams.get("error_description") ?? undefined,
    };
  }

  const code = url.searchParams.get("code");
  if (code) return { type: "code", code };

  return {
    type: "error",
    error: "missing_code",
    description: "Meta redirected to the callback without a code parameter.",
  };
}

export function renderCallbackHtml(model: CallbackHtmlModel): string {
  const statusColor = model.type === "success" ? "#126c43" : "#a32121";
  const details = redactDetails(model.details);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(model.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 48px auto; padding: 0 24px; line-height: 1.45; }
    h1 { color: ${statusColor}; font-size: 28px; }
    pre { background: #f4f4f5; border: 1px solid #ddd; border-radius: 8px; padding: 16px; overflow: auto; }
  </style>
</head>
<body>
  <h1>${escapeHtml(model.title)}</h1>
  <p>You can return to Codex. Do not paste access tokens into chat.</p>
  <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
</body>
</html>`;
}

export async function runCallbackServer(): Promise<void> {
  const config = loadConfig();
  if (!config.appId || !config.redirectUri) {
    throw new Error("Missing META_INSTAGRAM_APP_ID or META_INSTAGRAM_REDIRECT_URI.");
  }

  const redirectUrl = new URL(config.redirectUri);
  const port = Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80));
  if (!["localhost", "127.0.0.1"].includes(redirectUrl.hostname)) {
    throw new Error("Callback helper only supports localhost redirect URIs.");
  }

  const loginUrl = buildAuthUrl({
    authMode: config.authMode,
    appId: config.appId,
    redirectUri: config.redirectUri,
    scopes: config.defaultScopes,
    forceReauth: true,
    graphApiVersion: config.graphApiVersion,
  });

  const server = createServer(async (request, response) => {
    await handleCallbackRequest(request, response, {
      callbackPath: redirectUrl.pathname,
      authMode: config.authMode,
      appId: config.appId!,
      appSecret: config.appSecret,
      redirectUri: config.redirectUri!,
      graphApiVersion: config.graphApiVersion,
      tokenStorePath: config.tokenStorePath,
      close: () => server.close(),
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, redirectUrl.hostname, resolve);
  });

  console.log(`OAuth callback server listening on ${config.redirectUri}`);
  console.log(`Open this URL to authorize:\n${loginUrl.toString()}`);
}

async function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    callbackPath: string;
    authMode: "instagram" | "facebook";
    appId: string;
    appSecret?: string;
    redirectUri: string;
    graphApiVersion: string;
    tokenStorePath: string;
    close: () => void;
  },
): Promise<void> {
  const host = request.headers.host ?? "localhost";
  const parsed = parseCallbackRequest(`http://${host}${request.url ?? "/"}`, options.callbackPath);

  if (parsed.type === "ignored") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  if (parsed.type === "error") {
    response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderCallbackHtml({
      type: "error",
      title: "Meta authorization failed",
      details: parsed,
    }));
    queueClose(options.close);
    return;
  }

  try {
    if (!options.appSecret) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderCallbackHtml({
        type: "success",
        title: "Meta OAuth code captured",
        details: {
          code: parsed.code,
          next: "Set META_INSTAGRAM_APP_SECRET, then exchange this code with the meta_exchange_code MCP tool or add it to your local secure flow.",
        },
      }));
      queueClose(options.close);
      return;
    }

    const token = await exchangeCodeForLongLivedToken({
      authMode: options.authMode,
      code: parsed.code,
      appId: options.appId,
      appSecret: options.appSecret,
      redirectUri: options.redirectUri,
      graphApiVersion: options.graphApiVersion,
    });
    await saveStoredToken(options.tokenStorePath, token);

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderCallbackHtml({
      type: "success",
      title: "Meta token saved",
      details: {
        accessToken: redactToken(token.accessToken),
        tokenType: token.tokenType,
        authMode: token.authMode,
        userId: token.userId,
        pageId: token.pageId,
        permissions: token.permissions,
        expiresAt: token.expiresAt,
        tokenStorePath: options.tokenStorePath,
      },
    }));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    response.end(renderCallbackHtml({
      type: "error",
      title: "Instagram token exchange failed",
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  } finally {
    queueClose(options.close);
  }
}

function queueClose(close: () => void): void {
  setTimeout(close, 250);
}

function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      key.toLowerCase().includes("token") && typeof value === "string" ? redactToken(value) : value,
    ]),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
