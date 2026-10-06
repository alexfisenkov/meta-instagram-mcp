import { chmod, lstat, mkdir } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:INSTAGRAM_MCP_PRIVATE_FS_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Private path is unavailable.' }
$item = Get-Item -LiteralPath $path -Force
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($identity.Value, $system.Value, $administrators.Value)

if ($env:INSTAGRAM_MCP_PRIVATE_FS_OPERATION -eq 'protect') {
  if ($item.PSIsContainer) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($identity, $system, $administrators)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}

$actual = Get-Acl -LiteralPath $path
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$allowedAllows = @{}
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $allowed) { throw 'Private path grants access to another identity.' }
    $allowedAllows[$sid] = $true
  }
}
foreach ($sid in $allowed) {
  if (-not $allowedAllows.ContainsKey($sid)) { throw 'Private path is missing a required access rule.' }
}
`;

/** Windows mode bits do not represent owner/group/other privacy; use a protected NTFS DACL. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Private directory path must be a regular directory.");
  if (process.platform === "win32") {
    applyWindowsAcl(path);
    return;
  }
  await chmod(path, 0o700);
  const secured = await lstat(path);
  if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) {
    throw new Error("Private directory permissions could not be enforced.");
  }
}

/** Apply private access after creation and before writing sensitive file contents. */
export async function ensurePrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Private state must be a regular file.");
  if (process.platform === "win32") {
    applyWindowsAcl(path);
    return;
  }
  await chmod(path, 0o600);
  await assertPrivateFile(path);
}

/** Fail closed when a file is not a regular, private file on the current platform. */
export async function assertPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Private state must be a regular file.");
  if (process.platform === "win32") {
    applyWindowsAcl(path, "assert");
    return;
  }
  if ((info.mode & 0o077) !== 0) throw new Error("Private file permissions are not restricted.");
}

/** True only for a strict descendant, using the host OS path separator and comparison rules. */
export function isPathInside(root: string, target: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(target)) return false;
  const normalizedRoot = comparisonPath(root);
  const normalizedTarget = comparisonPath(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve existing symlink/junction ancestors before allowing a path outside the install tree. */
export function assertOutsideDirectory(root: string, target: string, message: string): void {
  const physicalRoot = effectivePath(root);
  const physicalTarget = effectivePath(target);
  if (isPathInside(physicalRoot, physicalTarget) || comparisonPath(physicalRoot) === comparisonPath(physicalTarget)) {
    throw new Error(message);
  }
}

function comparisonPath(value: string): string {
  const absolute = resolve(value);
  const root = parse(absolute).root;
  let normalized = absolute.replace(/[\\/]+$/, "");
  if (!normalized || normalized.toLowerCase() === root.replace(/[\\/]+$/, "").toLowerCase()) normalized = root;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Resolve through the nearest existing entry, then append missing path components. */
function effectivePath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error("Cannot safely resolve private path.");
  const absolute = resolve(input);
  const root = parse(absolute).root;
  let cursor = absolute;
  const missing: string[] = [];

  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot safely resolve private path.");
      const parent = dirname(cursor);
      if (parent === cursor || cursor === root) throw new Error("Cannot safely resolve private path.");
      missing.push(basename(cursor));
      cursor = parent;
      continue;
    }

    try {
      const physical = realpathSync.native(cursor);
      return resolve(physical, ...missing.reverse());
    } catch {
      throw new Error("Cannot safely resolve private path.");
    }
  }
}

function applyWindowsAcl(path: string, operation: "protect" | "assert" = "protect"): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows private filesystem support is unavailable.");
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  try {
    execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        INSTAGRAM_MCP_PRIVATE_FS_PATH: path,
        INSTAGRAM_MCP_PRIVATE_FS_OPERATION: operation,
      },
    });
  } catch {
    throw new Error("Windows private filesystem ACL could not be verified.");
  }
}
