#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyExternalConfig } from "./run.mjs";

const entries = {
  "auth-url": "auth-url.js",
  callback: "callback.js"
};

const selected = process.argv[2];
if (!entries[selected]) {
  process.stderr.write("Usage: node tools/cli.mjs <auth-url|callback>\n");
  process.exitCode = 2;
} else {
  try {
    applyExternalConfig();
    const target = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", entries[selected]);
    if (!existsSync(target)) throw new Error("BUILD_MISSING");
    await import(pathToFileURL(target).href);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "START_FAILED";
    process.stderr.write(`meta-instagram-mcp: ${code}\n`);
    process.exitCode = 1;
  }
}
