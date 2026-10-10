#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serverEntrypoint } from "./run.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = "remote-entrypoint-fixture-token-0123456789";

assert.equal(serverEntrypoint(packageRoot, {}), join(packageRoot, "dist", "server.js"));
for (const env of [
  { INSTAGRAM_MCP_REMOTE_CONFIG: "/private/remote.json" },
  { INSTAGRAM_MCP_REMOTE_URL: "https://mcp.example.test", INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: fixture },
  { INSTAGRAM_MCP_REMOTE_URL: "https://mcp.example.test" }
]) {
  assert.equal(serverEntrypoint(packageRoot, env), join(packageRoot, "dist", "cli", "remote-proxy.js"));
}

const home = await mkdtemp(join(tmpdir(), "instagram-remote-entrypoint-"));
try {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    INSTAGRAM_MCP_REMOTE_URL: "http://invalid.example",
    INSTAGRAM_MCP_REMOTE_BEARER_TOKEN: fixture,
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {})
  };
  const result = spawnSync(process.execPath, [join(packageRoot, "tools", "run.mjs")], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /remote proxy failed/);
  assert.doesNotMatch(result.stderr, /running on stdio|fixture-token|invalid\.example/i);
  console.log("remote entrypoint fixture: PASS (remote selection, local default, fail-closed invalid remote config)");
} finally {
  await rm(home, { recursive: true, force: true });
}
