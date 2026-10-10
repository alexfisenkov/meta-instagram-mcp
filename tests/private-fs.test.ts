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
$acl = [System.IO.File]::GetAccessControl($path)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Deny
)
[void]$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($path, $acl)
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
  }, 25_000);
});
