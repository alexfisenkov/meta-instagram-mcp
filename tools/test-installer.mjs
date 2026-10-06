#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "meta-instagram-installer-"));
const source = join(work, "source");
const target = join(work, "user data", "meta-instagram-mcp", "app");
const config = join(work, "user config", "meta-instagram-mcp");
const installShell = join(projectRoot, "install.sh");
const installPowerShell = join(projectRoot, "install.ps1");
const uninstallShell = join(projectRoot, "uninstall.sh");
const uninstallPowerShell = join(projectRoot, "uninstall.ps1");
const rollbackShell = join(projectRoot, "tools", "rollback.sh");
const rollbackPowerShell = join(projectRoot, "tools", "rollback.ps1");

function git(args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runInstaller(revision, configDir = config) {
  if (process.platform === "win32") {
    return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPowerShell,
      "-Revision", revision, "-SourceDir", source, "-Target", target, "-ConfigDir", configDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  return execFileSync("bash", [installShell, "--revision", revision, "--source-dir", source, "--target", target, "--config-dir", configDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runMaintenance(kind, backupPath) {
  const windows = process.platform === "win32";
  if (kind === "rollback") {
    if (windows) return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", rollbackPowerShell,
      "-Backup", backupPath, "-Target", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return execFileSync("bash", [rollbackShell, "--backup", backupPath, "--target", target],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  if (windows) return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", uninstallPowerShell,
    "-Confirmation", "REMOVE-APP", "-Target", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return execFileSync("bash", [uninstallShell, "--confirm", "REMOVE-APP", "--target", target],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function commitFixture(label, failBuild = false) {
  await writeFile(join(source, "revision.txt"), `${label}\n`);
  await writeFile(join(source, "tools", "build.mjs"), `import { mkdir, readFile, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\nconst root = new URL("../", import.meta.url);\nconst fail = ${String(failBuild)};\nif (fail) process.exit(23);\nconst server = await readFile(new URL("../fixture-server.mjs", import.meta.url), "utf8");\nawait mkdir(new URL("../dist/", import.meta.url), { recursive: true });\nawait writeFile(new URL("../dist/server.js", import.meta.url), server);\n`);
  git(["add", "-A"]);
  git(["commit", "-m", label]);
  return git(["rev-parse", "HEAD"]);
}

async function makeFixture() {
  await mkdir(join(source, "tools"), { recursive: true });
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  await writeFile(join(source, ".env.example"), "META_INSTAGRAM_APP_ID=\nMETA_INSTAGRAM_APP_SECRET=\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "installer-fixture", version: "0.0.1", type: "module", scripts: { build: "node tools/build.mjs" } }, null, 2) + "\n");
  await writeFile(join(source, "tools", "run.mjs"), await readFile(join(projectRoot, "tools", "run.mjs")));
  await writeFile(join(source, "tools", "guard-install-paths.mjs"), await readFile(join(projectRoot, "tools", "guard-install-paths.mjs")));
  await writeFile(join(source, "fixture-server.mjs"), `import readline from "node:readline";\nconst rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});\nfor await (const line of rl) { let m; try { m=JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result; if (m.method === "initialize") result={protocolVersion:m.params?.protocolVersion ?? "2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}; else if (m.method === "tools/list") result={tools:[{name:"meta_auth_status",description:"fixture",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true}},{name:"meta_source_status",description:"fixture",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true}}]}; else if (m.method === "tools/call" && m.params?.name === "meta_auth_status") result={content:[{type:"text",text:JSON.stringify({config:{hasAppId:Boolean(process.env.META_INSTAGRAM_APP_ID),hasAppSecret:Boolean(process.env.META_INSTAGRAM_APP_SECRET),tokenStorePath:process.env.META_TOKEN_STORE_PATH,userId:"FIXTURE_PRIVATE_ID"},envToken:process.env.META_INSTAGRAM_ACCESS_TOKEN,storedToken:{accessToken:"FIXTURE_PRIVATE_TOKEN",username:"FIXTURE_PRIVATE_USER"}})}]}; else if (m.method === "tools/call" && m.params?.name === "meta_source_status") result={content:[{type:"text",text:JSON.stringify({sources:[{source:"api",availability:"ready"},{source:"browser",availability:"not_connected"},{source:"phone",availability:"offline"}],private:"FIXTURE_PRIVATE_DATA"})}]}; else result={}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+String.fromCharCode(10)); }\n`);
  await writeFile(join(source, "tools", "build.mjs"), "");
  execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
  git(["config", "user.name", "Installer fixture"]);
  git(["config", "user.email", "installer-fixture@example.invalid"]);
  execFileSync(process.execPath, ["-e", "const fs=require('node:fs'); const p=require('node:path'); const d=process.argv[1]; fs.writeFileSync(p.join(d,'package-lock.json'), JSON.stringify({name:'installer-fixture',version:'0.0.1',lockfileVersion:3,requires:true,packages:{'':{name:'installer-fixture',version:'0.0.1'}}},null,2)+'\\n')", source], { stdio: "ignore" });
  await commitFixture("fixture-v1");
  await writeFile(join(source, ".env"), "META_INSTAGRAM_APP_ID=fixture-app-id\nMETA_INSTAGRAM_APP_SECRET=fixture-app-secret\nMETA_INSTAGRAM_ACCESS_TOKEN=fixture-token-value\n");
  if (process.platform !== "win32") await chmod(join(source, ".env"), 0o600);
}

try {
  await makeFixture();
  const first = git(["rev-parse", "HEAD"]);
  const invalidPin = "0".repeat(40);
  assert.throws(() => runInstaller(invalidPin), "installer must reject a SHA that differs from source HEAD");
  const firstOutput = runInstaller(first);
  assert.match(firstOutput, new RegExp(first));
  const initialState = JSON.parse(await readFile(join(target, ".meta-instagram-mcp-install.json"), "utf8"));
  assert.equal(initialState.revision, first);
  const envPath = join(config, ".env");
  const tokenPath = join(config, "token.json");
  const envBeforeUpdate = await readFile(envPath, "utf8");
  assert.equal(envBeforeUpdate.includes("fixture-app-secret"), true, "ignored local config should migrate to private config storage");
  execFileSync(process.execPath, ["--check", join(target, "dist", "server.js")], { stdio: "pipe" });
  await writeFile(tokenPath, JSON.stringify({ accessToken: "fixture-token-value", userId: "fixture-account" }));
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);

  const doctor = execFileSync(process.execPath, [join(projectRoot, "tools", "doctor.mjs"), "--install-dir", target, "--config-dir", config],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = JSON.parse(doctor);
  assert.equal(report.mcp.connected, true);
  assert.equal(report.mcp.toolCount, 2);
  assert.equal(report.mcp.appCredentialsPresent, true);
  assert.equal(report.mcp.accessTokenPresent, true);
  assert.deepEqual(report.sourceStatus.bySource, { api: "ready", browser: "not_connected", phone: "offline" });
  for (const privateMarker of ["fixture-app-secret", "fixture-token-value", "FIXTURE_PRIVATE_ID", "FIXTURE_PRIVATE_USER", "FIXTURE_PRIVATE_DATA"]) {
    assert.equal(doctor.includes(privateMarker), false, "doctor must not print credentials or account payload");
  }

  const second = await commitFixture("fixture-v2");
  const targetPrivateConfig = join(target, "private-config");
  await mkdir(targetPrivateConfig);
  const targetPrivateEnv = join(targetPrivateConfig, ".env");
  const targetPrivateToken = join(targetPrivateConfig, "token.json");
  await writeFile(targetPrivateEnv, "META_INSTAGRAM_APP_SECRET=inside-managed-target\n");
  await writeFile(targetPrivateToken, JSON.stringify({ accessToken: "inside-managed-token" }));
  const configAlias = join(work, "user config alias", "meta-instagram-mcp");
  await mkdir(dirname(configAlias), { recursive: true });
  await symlink(targetPrivateConfig, configAlias, process.platform === "win32" ? "junction" : "dir");
  const activeStateBeforeAliasUpdate = await readFile(join(target, ".meta-instagram-mcp-install.json"));
  const backupCountBeforeAliasUpdate = (await readdir(dirname(target))).filter((entry) => entry.startsWith("app.backup.")).length;
  assert.throws(() => runInstaller(second, configAlias), "config aliases resolving inside the managed target must be rejected before update");
  assert.deepEqual(await readFile(join(target, ".meta-instagram-mcp-install.json")), activeStateBeforeAliasUpdate,
    "a rejected config alias must leave the active installation state untouched");
  assert.deepEqual(await readFile(targetPrivateEnv), Buffer.from("META_INSTAGRAM_APP_SECRET=inside-managed-target\n"),
    "a rejected config alias must not mutate configuration inside the active target");
  assert.deepEqual(JSON.parse(await readFile(targetPrivateToken, "utf8")), { accessToken: "inside-managed-token" },
    "a rejected config alias must preserve private token data");
  assert.equal((await readdir(dirname(target))).filter((entry) => entry.startsWith("app.backup.")).length, backupCountBeforeAliasUpdate,
    "a rejected config alias must not create a backup by moving the active target");
  const configAliasParent = join(work, "user config parent alias");
  await symlink(targetPrivateConfig, configAliasParent, process.platform === "win32" ? "junction" : "dir");
  const nestedConfigAlias = join(configAliasParent, "not-created", "meta-instagram-mcp");
  assert.throws(() => runInstaller(second, nestedConfigAlias), "missing config descendants under a junction/symlink must be resolved before creation");
  assert.deepEqual(await readFile(join(target, ".meta-instagram-mcp-install.json")), activeStateBeforeAliasUpdate,
    "a rejected config descendant must leave the active installation state untouched");
  assert.deepEqual(await readFile(targetPrivateEnv), Buffer.from("META_INSTAGRAM_APP_SECRET=inside-managed-target\n"),
    "a rejected config descendant must not mutate configuration inside the active target");
  assert.equal((await readdir(dirname(target))).filter((entry) => entry.startsWith("app.backup.")).length, backupCountBeforeAliasUpdate,
    "a rejected config descendant must not create a backup by moving the active target");
  await rm(configAliasParent, { force: true });
  await rm(configAlias, { force: true });
  await rm(targetPrivateConfig, { recursive: true, force: true });

  const updateOutput = runInstaller(second);
  const backupPath = updateOutput.split(/\r?\n/).find((line) => line.startsWith("Previous install backup: "))?.slice("Previous install backup: ".length);
  assert.ok(backupPath && backupPath.includes(".backup."));
  assert.equal(JSON.parse(await readFile(join(target, ".meta-instagram-mcp-install.json"), "utf8")).revision, second);
  assert.equal(await readFile(envPath, "utf8"), envBeforeUpdate);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, "utf8")), { accessToken: "fixture-token-value", userId: "fixture-account" });

  const bad = await commitFixture("fixture-v3-build-fails", true);
  assert.throws(() => runInstaller(bad), "a failed candidate build must stop before replacing the active installation");
  assert.equal(JSON.parse(await readFile(join(target, ".meta-instagram-mcp-install.json"), "utf8")).revision, second);

  runMaintenance("rollback", backupPath);
  assert.equal(JSON.parse(await readFile(join(target, ".meta-instagram-mcp-install.json"), "utf8")).revision, first);
  assert.equal(await readFile(envPath, "utf8"), envBeforeUpdate);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, "utf8")), { accessToken: "fixture-token-value", userId: "fixture-account" });

  const uninstallOutput = runMaintenance("uninstall");
  const archivedPath = uninstallOutput.split(/\r?\n/).find((line) => line.startsWith("App archived: "))?.slice("App archived: ".length);
  assert.ok(archivedPath);
  assert.equal(JSON.parse(await readFile(join(archivedPath, ".meta-instagram-mcp-install.json"), "utf8")).revision, first);
  assert.equal(await readFile(envPath, "utf8"), envBeforeUpdate);
  assert.deepEqual(JSON.parse(await readFile(tokenPath, "utf8")), { accessToken: "fixture-token-value", userId: "fixture-account" });
  process.stdout.write("installer fixture: PASS (pin, external env/doctor redaction, config link containment, update preservation, failed-build safety, rollback, uninstall archive)\n");
} finally {
  await rm(work, { recursive: true, force: true });
}
