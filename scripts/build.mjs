#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const tsc = "node_modules/typescript/bin/tsc";
if (!existsSync(tsc)) {
  console.error("typescript is not installed. Run npm install first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status ?? 1);
try {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const workingTreeClean = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length === 0;
  mkdirSync("dist/student", { recursive: true });
  writeFileSync("dist/student/build-info.json", `${JSON.stringify({ sourceSha, workingTreeClean })}\n`, { mode: 0o600 });
} catch { /* Non-Git package builds remain valid; provenance-gated E2E requires this marker. */ }
