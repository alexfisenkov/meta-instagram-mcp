#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultConfigDirectory, loadExternalConfig } from "./run.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(toolDirectory, "..");

function defaultInstallDirectory(env = process.env) {
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "meta-instagram-mcp", "app");
  }
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(dataHome, "meta-instagram-mcp", "app");
}

function parseOptions(args) {
  const options = { installDirectory: defaultInstallDirectory(), configDirectory: defaultConfigDirectory() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node tools/doctor.mjs [--install-dir PATH] [--config-dir PATH]\n");
      process.exit(0);
    }
    if (arg === "--install-dir" || arg === "--config-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("OPTION_VALUE_MISSING");
      if (arg === "--install-dir") options.installDirectory = resolve(value);
      else options.configDirectory = resolve(value);
      index += 1;
      continue;
    }
    throw new Error("OPTION_UNKNOWN");
  }
  return options;
}

function safeConfigSummary(configDirectory) {
  let external;
  try {
    external = loadExternalConfig(configDirectory);
  } catch {
    return { configFilePresent: existsSync(join(configDirectory, ".env")), configReadable: false,
      hasAppId: false, hasAppSecret: false, hasEnvToken: false };
  }
  const values = external.values;
  return {
    configFilePresent: external.loaded,
    configReadable: true,
    hasAppId: Boolean(process.env.META_INSTAGRAM_APP_ID || values.META_INSTAGRAM_APP_ID),
    hasAppSecret: Boolean(process.env.META_INSTAGRAM_APP_SECRET || values.META_INSTAGRAM_APP_SECRET),
    hasEnvToken: Boolean(process.env.META_INSTAGRAM_ACCESS_TOKEN || values.META_INSTAGRAM_ACCESS_TOKEN)
  };
}

function safeInstallSummary(installDirectory) {
  try {
    const pkg = JSON.parse(readFileSync(join(installDirectory, "package.json"), "utf8"));
    const result = { version: typeof pkg.version === "string" ? pkg.version : "unknown" };
    try {
      const state = JSON.parse(readFileSync(join(installDirectory, ".meta-instagram-mcp-install.json"), "utf8"));
      if (typeof state.revision === "string" && /^[a-f0-9]{40}$/i.test(state.revision)) result.revision = state.revision.toLowerCase();
    } catch {
      // A source checkout has no installer state marker.
    }
    return result;
  } catch {
    return { version: "unknown" };
  }
}

function textPayload(result) {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function findSourceStates(value, found = {}) {
  if (Array.isArray(value)) {
    for (const item of value) findSourceStates(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const row = value;
  const source = row.source;
  const availability = row.availability;
  if (["api", "browser", "phone"].includes(source)
      && ["ready", "permission_blocked", "missing_scope", "offline", "not_connected", "unsupported", "unsupported_ui_version", "needs_selection"].includes(availability)) {
    found[source] = availability;
  }
  for (const item of Object.values(row)) findSourceStates(item, found);
  return found;
}

async function runDoctor() {
  const options = parseOptions(process.argv.slice(2));
  const configSummary = safeConfigSummary(options.configDirectory);
  let tokenFilePresent = false;
  try {
    const external = loadExternalConfig(options.configDirectory);
    const tokenPath = process.env.META_TOKEN_STORE_PATH || external.values.META_TOKEN_STORE_PATH
      || join(options.configDirectory, "token.json");
    tokenFilePresent = existsSync(tokenPath);
  } catch {
    tokenFilePresent = false;
  }
  const report = {
    app: safeInstallSummary(options.installDirectory),
    installPresent: existsSync(join(options.installDirectory, "dist", "server.js")),
    config: { ...configSummary, tokenFilePresent },
    mcp: { connected: false, toolCount: 0, authStatusAvailable: false, authStatusCall: "unavailable" },
    sourceStatus: { toolAvailable: false, bySource: {} }
  };
  const serverPath = join(options.installDirectory, "tools", "run.mjs");
  if (!report.installPresent || !existsSync(serverPath) || !configSummary.configReadable) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: options.installDirectory,
    env: { ...process.env, META_MCP_CONFIG_DIR: options.configDirectory },
    stderr: "pipe"
  });
  const client = new Client({ name: "meta-instagram-mcp-doctor", version: "1.0.0" });
  const startupErrorCodes = [];
  transport.stderr?.on("data", (chunk) => {
    const match = String(chunk).match(/meta-instagram-mcp: ([A-Z0-9_]+)/);
    if (match) startupErrorCodes.push(match[1]);
  });
  try {
    await client.connect(transport);
    report.mcp.connected = true;
    const listed = await client.listTools();
    report.mcp.toolCount = listed.tools.length;
    const authTool = listed.tools.find((tool) => tool.name === "meta_auth_status");
    report.mcp.authStatusAvailable = Boolean(authTool);
    if (authTool) {
      try {
        const result = await client.callTool({ name: authTool.name, arguments: {} });
        report.mcp.authStatusCall = result.isError ? "error" : "ok";
        if (!result.isError) {
          try {
            const payload = JSON.parse(textPayload(result));
            report.mcp.appCredentialsPresent = Boolean(payload.config?.hasAppId && payload.config?.hasAppSecret);
            report.mcp.accessTokenPresent = Boolean(payload.envToken || payload.storedToken?.accessToken);
          } catch {
            report.mcp.authStatusCall = "unreadable";
          }
        }
      } catch {
        report.mcp.authStatusCall = "error";
      }
    }

    const sourceTools = listed.tools.filter((tool) => /capabilit|source.*status/i.test(tool.name)
      && tool.annotations?.readOnlyHint === true);
    report.sourceStatus.toolAvailable = sourceTools.length > 0;
    for (const tool of sourceTools) {
      try {
        const result = await client.callTool({ name: tool.name, arguments: {} });
        if (!result.isError) Object.assign(report.sourceStatus.bySource, findSourceStates(JSON.parse(textPayload(result))));
      } catch {
        // The diagnostic reports availability only; tool error details may contain account data.
      }
    }
  } catch (error) {
    report.mcp.connection = "failed";
    report.mcp.connectionError = error instanceof Error ? error.name : "UnknownError";
    if (error && typeof error === "object" && "code" in error && typeof error.code === "number") {
      report.mcp.connectionErrorCode = error.code;
    }
    if (startupErrorCodes.length) report.mcp.serverStartErrorCode = startupErrorCodes.at(-1);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

runDoctor().catch(() => {
  process.stderr.write("meta-instagram-mcp doctor: check the install path and config file permissions.\n");
  process.exitCode = 1;
});
