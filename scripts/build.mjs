#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const tsc = "node_modules/typescript/bin/tsc";
if (!existsSync(tsc)) {
  console.error("typescript is not installed. Run npm install first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);
