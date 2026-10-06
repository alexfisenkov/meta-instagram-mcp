import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOutsideDirectory, assertPrivateFile, ensurePrivateDirectory, ensurePrivateFile, isPathInside } from "../src/private-fs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("private filesystem helpers", () => {
  it("starts PowerShell with the production environment and a Windows runner environment", () => {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeTruthy();
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.WriteLine('MCP_PRIVATE_FS_PROBE_OK')"];
    const run = (env: NodeJS.ProcessEnv): string => {
      try {
        const output = execFileSync(powershell, args, {
          encoding: "utf8",
          timeout: 4_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env,
        });
        return output.trim() === "MCP_PRIVATE_FS_PROBE_OK" ? "PASS" : "BAD_OUTPUT";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return ["EACCES", "ENOENT", "EPERM", "ETIMEDOUT"].includes(code ?? "") ? code! : "PROCESS_FAILURE";
      }
    };
    const minimal = { SystemRoot: systemRoot, WINDIR: systemRoot, INSTAGRAM_MCP_PRIVATE_FS_PROBE: "1" };
    const runner = { ...minimal } as NodeJS.ProcessEnv;
    for (const name of ["PATH", "PATHEXT", "PSModulePath", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]) {
      const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (entry) runner[name] = entry[1];
    }
    const result = { minimal: run(minimal), runner: run(runner) };
    expect(result).toEqual({ minimal: "PASS", runner: "PASS" });
  }, 12_000);

  it("reads the same synthetic directory with Get-Item in both PowerShell environments", async () => {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeTruthy();
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const root = await mkdtemp(join(tmpdir(), "mcp-private-get-item-"));
    temporaryDirectories.push(root);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('MCP_PRIVATE_FS_STAGE|BEFORE_GET_ITEM')
$item = Get-Item -LiteralPath $env:INSTAGRAM_MCP_PRIVATE_FS_PROBE_PATH -Force
if (-not $item.PSIsContainer) { exit 3 }
[Console]::Out.WriteLine('MCP_PRIVATE_FS_GET_ITEM_OK')
`;
    const run = (env: NodeJS.ProcessEnv): string => {
      try {
        const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          timeout: 4_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...env, INSTAGRAM_MCP_PRIVATE_FS_PROBE_PATH: root },
        });
        return output.trim() === "MCP_PRIVATE_FS_GET_ITEM_OK" ? "PASS" : "BAD_OUTPUT";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return ["EACCES", "ENOENT", "EPERM", "ETIMEDOUT"].includes(code ?? "") ? code! : "PROCESS_FAILURE";
      }
    };
    const minimal = { SystemRoot: systemRoot, WINDIR: systemRoot, INSTAGRAM_MCP_PRIVATE_FS_PROBE: "1" };
    const runner = { ...minimal } as NodeJS.ProcessEnv;
    for (const name of ["PATH", "PATHEXT", "PSModulePath", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]) {
      const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (entry) runner[name] = entry[1];
    }
    const modulePathOnly = { ...minimal } as NodeJS.ProcessEnv;
    const modulePath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "psmodulepath");
    if (modulePath) modulePathOnly.PSModulePath = modulePath[1];
    const minimalResult = run(minimal);
    expect(["PASS", "ETIMEDOUT"]).toContain(minimalResult);
    expect({ modulePathOnly: run(modulePathOnly), runner: run(runner) }).toEqual({ modulePathOnly: "PASS", runner: "PASS" });
  }, 12_000);

  it("checks containment using the host path rules", () => {
    const root = resolve(tmpdir(), "mcp-private-fixture");
    expect(isPathInside(root, join(root, "child", "state.json"))).toBe(true);
    expect(isPathInside(root, resolve(root, "..", "outside.json"))).toBe(false);
    expect(isPathInside(root, root)).toBe(false);
  });

  it("rejects external-looking paths whose existing ancestor aliases the project tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-private-path-"));
    temporaryDirectories.push(root);
    const project = join(root, "install");
    const alias = join(root, "external-alias");
    await mkdir(project);
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    const redirectedKey = join(alias, "nested", "approval-key.json");

    expect(() => assertOutsideDirectory(project, redirectedKey, "must remain outside")).toThrow("must remain outside");
    await expect(access(join(project, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(redirectedKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies and verifies private file access for the current platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-private-fs-"));
    temporaryDirectories.push(root);
    const directory = join(root, "private");
    await mkdir(directory);
    await ensurePrivateDirectory(directory);

    const path = join(directory, "state.json");
    await writeFile(path, "fixture", { mode: 0o600 });
    await ensurePrivateFile(path);
    await expect(assertPrivateFile(path)).resolves.toBeUndefined();

    if (process.platform === "win32") {
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:INSTAGRAM_MCP_TEST_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Deny
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, INSTAGRAM_MCP_TEST_ACL_PATH: path },
      });
      await expect(assertPrivateFile(path)).rejects.toThrow(/ACL/);
      await ensurePrivateFile(path);
      await expect(assertPrivateFile(path)).resolves.toBeUndefined();
    }
  });
});
