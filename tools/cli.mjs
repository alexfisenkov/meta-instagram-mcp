#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyExternalConfig } from "./run.mjs";

const entries = {
  "auth-url": "auth-url.js",
  callback: "callback.js",
  "remote-proxy": "remote-proxy.js"
};

const selected = process.argv[2];
if (selected === "browser-setup") {
  const { runBrowserSetupCli } = await import("./browser-setup.mjs");
  await runBrowserSetupCli(process.argv.slice(3));
} else if (!entries[selected]) {
  process.stderr.write("Usage: node tools/cli.mjs <auth-url|callback|browser-setup>\n");
  process.exitCode = 2;
} else {
  try {
    applyExternalConfig();
    const target = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", entries[selected]);
    if (!existsSync(target)) throw new Error("BUILD_MISSING");
    const command = await import(pathToFileURL(target).href);
    if (selected === "remote-proxy") await command.startRemoteProxy();
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "START_FAILED";
    process.stderr.write(`meta-instagram-mcp: ${code}\n`);
    process.exitCode = 1;
  }
}
