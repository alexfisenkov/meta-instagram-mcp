#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "meta-instagram-installer-"));
const source = join(work, "source");
const target = join(work, "user data", "meta-instagram-mcp", "app");
const config = join(work, "user config", "meta-instagram-mcp");
const expectedHubPath = join(work, "private runtime", "hub-state.json");
const installShell = join(projectRoot, "install.sh");
const installPowerShell = join(projectRoot, "install.ps1");
const uninstallShell = join(projectRoot, "uninstall.sh");
const uninstallPowerShell = join(projectRoot, "uninstall.ps1");
const rollbackShell = join(projectRoot, "tools", "rollback.sh");
const rollbackPowerShell = join(projectRoot, "tools", "rollback.ps1");

function git(args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runInstaller(revision, configDir = config, options = {}) {
  const { env = process.env, targetPath = target } = options;
  if (process.platform === "win32") {
    return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPowerShell,
      "-Revision", revision, "-SourceDir", source, "-Target", targetPath, "-ConfigDir", configDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  }
  return execFileSync("bash", [installShell, "--revision", revision, "--source-dir", source, "--target", targetPath, "--config-dir", configDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
}

async function nodeFloorEnvironment(major) {
  const directory = join(work, `node-${major}-bin`);
  await mkdir(directory, { recursive: true });
  const shim = process.platform === "win32" ? join(directory, "node.cmd") : join(directory, "node");
  const body = process.platform === "win32"
    ? `@echo off\r\necho %*| findstr /L /C:"process.versions.node" >nul\r\nif not errorlevel 1 (\r\n  echo %FIXTURE_NODE_MAJOR%\r\n  exit /b 0\r\n)\r\necho FIXTURE_NODE_PREFLIGHT_ACCEPTED 1>&2\r\nexit /b 97\r\n`
    : `#!/bin/sh\ncase "$*" in\n  *process.versions.node*) if [ "$1" = "-p" ]; then printf '%s\\n' "$FIXTURE_NODE_MAJOR"; exit 0; fi; [ "$FIXTURE_NODE_MAJOR" -ge 22 ]; exit $? ;;\nesac\nprintf 'FIXTURE_NODE_PREFLIGHT_ACCEPTED\\n' >&2\nexit 97\n`;
  await writeFile(shim, body);
  if (process.platform !== "win32") await chmod(shim, 0o700);
  const env = { ...process.env, FIXTURE_NODE_MAJOR: String(major) };
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${directory}${process.platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
  return env;
}

function installerFailure(run, expected) {
  try {
    run();
  } catch (error) {
    const failure = error && typeof error === "object"
      ? [error.message, error.stdout, error.stderr].map((value) => value?.toString?.() ?? "").join("\n")
      : String(error);
    assert.match(failure, expected);
    return failure;
  }
  throw new Error("Installer preflight unexpectedly continued.");
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

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function isolatedEnvironment(home, config) {
  const env = {};
  for (const name of ["PATH", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.META_MCP_CONFIG_DIR = config;
  return env;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error("PORTABLE_WRAPPER_EXITED_BEFORE_LISTENER");
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200) return;
    } catch { /* The listener is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PORTABLE_WRAPPER_LISTENER_TIMEOUT");
}

async function assertHealthListenerStops(url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) });
      await response.body?.cancel();
      throw new Error("PORTABLE_WRAPPER_CHILD_REMAINS_LIVE");
    } catch (error) {
      if (error instanceof Error && error.message === "PORTABLE_WRAPPER_CHILD_REMAINS_LIVE") throw error;
      const code = error && typeof error === "object" ? error.cause?.code : undefined;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") return;
      if (!(error instanceof Error) || !["AbortError", "TimeoutError"].includes(error.name)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PORTABLE_WRAPPER_CHILD_SHUTDOWN_TIMEOUT");
}

async function assertRuntimeTools(client, transport) {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 27, "the portable wrapper must start the compiled server with all runtime tools");
  const capabilities = await client.callTool({ name: "meta_capabilities", arguments: {} });
  const capabilityPayload = JSON.parse(capabilities.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "{}");
  assert.equal(capabilityPayload.sources?.length, 3, "runtime capabilities must report API, browser, and phone independently");
  const triage = await client.callTool({ name: "meta_triage_inbox", arguments: { source: "auto", limit: 3 } });
  const triagePayload = JSON.parse(triage.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "{}");
  assert.ok(Array.isArray(triagePayload.triedSources));
  assert.ok(Array.isArray(triagePayload.items));
}

async function verifyCompiledPortableWrapper() {
  const realRuntime = join(work, "compiled runtime");
  const home = join(realRuntime, "home");
  const stdioConfig = join(realRuntime, "stdio config");
  const httpConfig = join(realRuntime, "http config");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(stdioConfig, { recursive: true }), mkdir(httpConfig, { recursive: true })]);
  const minimalConfig = "META_AUTH_MODE=facebook\nMETA_INSTAGRAM_REDIRECT_URI=http://localhost:8787/callback\n";
  await writeFile(join(stdioConfig, ".env"), minimalConfig, { mode: 0o600 });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bearer = `test-${randomBytes(32).toString("base64url")}`;
  await writeFile(join(httpConfig, ".env"), `${minimalConfig}INSTAGRAM_MCP_TRANSPORT=http\nINSTAGRAM_MCP_HTTP_HOST=127.0.0.1\nINSTAGRAM_MCP_HTTP_PORT=${port}\nINSTAGRAM_MCP_HTTP_BEARER_TOKEN=${bearer}\nINSTAGRAM_MCP_HTTP_ALLOWED_HOSTS=127.0.0.1:${port}\nINSTAGRAM_MCP_HTTP_ALLOWED_ORIGINS=${baseUrl}\n`, { mode: 0o600 });

  const wrapperPath = join(projectRoot, "tools", "run.mjs");
  const common = { command: process.execPath, args: [wrapperPath], cwd: projectRoot };
  const stdioClient = new Client({ name: "portable-wrapper-stdio-fixture", version: "1" });
  const stdioTransport = new StdioClientTransport({ ...common, env: isolatedEnvironment(home, stdioConfig) });
  try {
    await assertRuntimeTools(stdioClient, stdioTransport);
  } finally {
    await stdioClient.close().catch(() => undefined);
  }

  const httpChild = spawn(process.execPath, [wrapperPath], {
    cwd: projectRoot,
    env: isolatedEnvironment(home, httpConfig),
    stdio: ["ignore", "ignore", "pipe"]
  });
  try {
    await waitForHealth(baseUrl, httpChild);
    const health = await fetch(`${baseUrl}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal((await fetch(`${baseUrl}/health`, { headers: { origin: "http://invalid.example" } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${baseUrl}/oauth/callback`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/webhook`)).status, 404);

    const httpClient = new Client({ name: "portable-wrapper-http-fixture", version: "1" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } }
    });
    try {
      await assertRuntimeTools(httpClient, httpTransport);
    } finally {
      await httpClient.close().catch(() => undefined);
    }
  } finally {
    if (httpChild.exitCode === null) {
      const closed = new Promise((resolve) => httpChild.once("close", (code, signal) => resolve({ code, signal })));
      httpChild.kill("SIGTERM");
      const result = await closed;
      if (process.platform === "win32") {
        assert.equal(result.code, null, "Windows terminates the wrapper process directly instead of reporting a POSIX exit code");
        assert.equal(result.signal, "SIGTERM", "the Windows child-process close event must identify the requested termination signal");
      }
      else assert.equal(result.signal, "SIGTERM", "the portable wrapper must preserve child termination signals");
    }
    await assertHealthListenerStops(baseUrl);
  }
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
  await writeFile(join(source, "fixture-server.mjs"), `import readline from "node:readline";\nconst expectedHubPath=${JSON.stringify(expectedHubPath)};\nconst rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});\nfor await (const line of rl) { let m; try { m=JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result; if (m.method === "initialize") result={protocolVersion:m.params?.protocolVersion ?? "2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}; else if (m.method === "tools/list") result={tools:[{name:"meta_auth_status",description:"fixture",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true}},{name:"meta_source_status",description:"fixture",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true}},{name:"meta_runtime_probe",description:"fixture",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true}}]}; else if (m.method === "tools/call" && m.params?.name === "meta_auth_status") result={content:[{type:"text",text:JSON.stringify({config:{hasAppId:Boolean(process.env.META_INSTAGRAM_APP_ID),hasAppSecret:Boolean(process.env.META_INSTAGRAM_APP_SECRET),tokenStorePath:process.env.META_TOKEN_STORE_PATH,userId:"FIXTURE_PRIVATE_ID"},envToken:process.env.META_INSTAGRAM_ACCESS_TOKEN,storedToken:{accessToken:"FIXTURE_PRIVATE_TOKEN",username:"FIXTURE_PRIVATE_USER"}})}]}; else if (m.method === "tools/call" && m.params?.name === "meta_source_status") result={content:[{type:"text",text:JSON.stringify({sources:[{source:"api",availability:"ready"},{source:"browser",availability:"not_connected"},{source:"phone",availability:"offline"}],private:"FIXTURE_PRIVATE_DATA"})}]}; else if (m.method === "tools/call" && m.params?.name === "meta_runtime_probe") result={content:[{type:"text",text:JSON.stringify({transport:process.env.INSTAGRAM_MCP_TRANSPORT,hubStatePathMatches:process.env.INSTAGRAM_MCP_HUB_STATE_PATH===expectedHubPath,browserWritesEnabled:process.env.INSTAGRAM_MCP_BROWSER_WRITES==="true",phoneWritesEnabled:process.env.INSTAGRAM_MCP_PHONE_WRITES==="true",apiWritesEnabled:process.env.META_INSTAGRAM_WRITE==="true",literalValueUnexpanded:process.env.META_GRAPH_FALLBACK_IPS==='$(printf fixture-literal)',sourceStatuses:{api:"ready",browser:"not_connected",phone:"offline"}})}]}; else result={}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+String.fromCharCode(10)); }\n`);
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
  const rejectedTarget = join(work, "node-20-rejected", "app");
  const node20 = await nodeFloorEnvironment(20);
  installerFailure(() => runInstaller(first, join(work, "node-20-config"), { env: node20, targetPath: rejectedTarget }), /Node\.js 22 or newer is required/);
  await assert.rejects(access(rejectedTarget), { code: "ENOENT" });
  const acceptedTarget = join(work, "node-22-preflight", "app");
  const node22 = await nodeFloorEnvironment(22);
  installerFailure(() => runInstaller(first, join(work, "node-22-config"), { env: node22, targetPath: acceptedTarget }), /FIXTURE_NODE_PREFLIGHT_ACCEPTED/);
  await assert.rejects(access(acceptedTarget), { code: "ENOENT" });
  const firstOutput = runInstaller(first);
  assert.match(firstOutput, new RegExp(first));
  const initialState = JSON.parse(await readFile(join(target, ".meta-instagram-mcp-install.json"), "utf8"));
  assert.equal(initialState.revision, first);
  const envPath = join(config, ".env");
  const tokenPath = join(config, "token.json");
  let envBeforeUpdate = await readFile(envPath, "utf8");
  assert.equal(envBeforeUpdate.includes("fixture-app-secret"), true, "ignored local config should migrate to private config storage");
  execFileSync(process.execPath, ["--check", join(target, "dist", "server.js")], { stdio: "pipe" });
  const runtimeEnv = [
    "INSTAGRAM_MCP_TRANSPORT=http",
    `INSTAGRAM_MCP_HUB_STATE_PATH=\"${expectedHubPath}\"`,
    "INSTAGRAM_MCP_BROWSER_WRITES=true",
    "INSTAGRAM_MCP_PHONE_WRITES=true",
    "META_INSTAGRAM_WRITE=true",
    'META_GRAPH_FALLBACK_IPS="$(printf fixture-literal)"'
  ].join("\n") + "\n";
  await writeFile(envPath, `${envBeforeUpdate}${runtimeEnv}`);
  if (process.platform !== "win32") await chmod(envPath, 0o600);
  envBeforeUpdate = await readFile(envPath, "utf8");
  const { loadExternalConfig } = await import(pathToFileURL(join(target, "tools", "run.mjs")).href);
  assert.equal(loadExternalConfig(config).values.META_GRAPH_FALLBACK_IPS, "$(printf fixture-literal)", "dotenv content must remain literal text");
  await writeFile(envPath, "META_MCP_CONFIG_DIR=/tmp/should-not-be-overridden\n");
  if (process.platform !== "win32") await chmod(envPath, 0o600);
  assert.throws(() => loadExternalConfig(config), /CONFIG_NAME_UNSUPPORTED_1/, "external config must reject META_MCP_CONFIG_DIR");
  await writeFile(envPath, envBeforeUpdate);
  if (process.platform !== "win32") await chmod(envPath, 0o600);
  const runtimeClient = new Client({ name: "installer-runtime-fixture", version: "1" });
  const runtimeTransport = new StdioClientTransport({ command: process.execPath, args: [join(target, "tools", "run.mjs")], cwd: target,
    env: { META_MCP_CONFIG_DIR: config } });
  try {
    await runtimeClient.connect(runtimeTransport);
    const probe = await runtimeClient.callTool({ name: "meta_runtime_probe", arguments: {} });
    const runtimeState = JSON.parse(probe.content?.find((item) => item.type === "text")?.text ?? "{}");
    assert.equal(runtimeState.transport, "http", "private external config should select HTTP runtime mode through the installed wrapper");
    assert.equal(runtimeState.hubStatePathMatches, true, "private external config should select the configured Hub state path");
    assert.deepEqual(runtimeState.sourceStatuses, { api: "ready", browser: "not_connected", phone: "offline" }, "source readiness should remain independently gated");
    assert.equal(runtimeState.browserWritesEnabled, true);
    assert.equal(runtimeState.phoneWritesEnabled, true);
    assert.equal(runtimeState.apiWritesEnabled, true);
    assert.equal(runtimeState.literalValueUnexpanded, true, "dotenv values must not undergo shell substitution");
  } finally {
    await runtimeClient.close().catch(() => undefined);
  }
  await writeFile(tokenPath, JSON.stringify({ accessToken: "fixture-token-value", userId: "fixture-account" }));
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);

  const doctor = execFileSync(process.execPath, [join(projectRoot, "tools", "doctor.mjs"), "--install-dir", target, "--config-dir", config],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = JSON.parse(doctor);
  assert.equal(report.mcp.connected, true);
  assert.equal(report.mcp.toolCount, 3);
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

  await verifyCompiledPortableWrapper();
  process.stdout.write("installer fixture: PASS (pin, external env/doctor redaction, config link containment, update preservation, failed-build safety, rollback, uninstall archive)\n");
} finally {
  await rm(work, { recursive: true, force: true });
}
