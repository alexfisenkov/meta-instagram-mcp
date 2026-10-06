import { chmod, lstat, mkdir } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Write-Stage([string]$Name) {
  [Console]::Error.WriteLine("MCP_PRIVATE_FS_STAGE|$Name")
}
trap {
  $category = [string]$_.CategoryInfo.Category
  $exceptionType = $_.Exception.GetType().Name
  $errorCode = switch -Regex ($_.FullyQualifiedErrorId) {
    'CommandNotFoundException' { 'COMMAND_NOT_FOUND'; break }
    'UnauthorizedAccessException' { 'ACCESS_DENIED'; break }
    'SecurityException' { 'SECURITY_EXCEPTION'; break }
    'MethodInvocationException' { 'METHOD_INVOCATION'; break }
    default { 'POWERSHELL_FAILURE' }
  }
  [Console]::Error.WriteLine("MCP_PRIVATE_FS|$exceptionType|$category|$errorCode")
  exit 42
}
Write-Stage 'START'
$path = $env:INSTAGRAM_MCP_PRIVATE_FS_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Private path is unavailable.' }
Write-Stage 'GET_ITEM'
$item = Get-Item -LiteralPath $path -Force
Write-Stage 'ITEM'
Write-Stage 'IDENTITY'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($identity.Value, $system.Value, $administrators.Value)
Write-Stage 'IDENTITY_READY'

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
  Write-Stage 'SET_ACL'
  Set-Acl -LiteralPath $path -AclObject $acl
  Write-Stage 'SET_DONE'
}

Write-Stage 'GET_ACL'
$actual = Get-Acl -LiteralPath $path
Write-Stage 'ACL_READ'
if (-not $actual.AreAccessRulesProtected) { throw 'Private path access rules are not protected.' }
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
Write-Stage 'RULES_READ'
$allowedAllows = @{}
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Value
  if ($sid -notin $allowed -or $rule.IsInherited) { throw 'Private path grants access to another identity.' }
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
      throw 'Private path is missing a full-control access rule.'
    }
    $allowedAllows[$sid] = $true
  } elseif ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Deny) {
    throw 'Private path contains an unsupported access rule.'
  } else {
    throw 'Private path denies access to a required identity.'
  }
}
foreach ($sid in $allowed) {
  if (-not $allowedAllows.ContainsKey($sid)) { throw 'Private path is missing a required access rule.' }
}
Write-Stage 'COMPLETE'
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
  const psModulePath = Object.entries(process.env).find(([name]) => name.toLowerCase() === "psmodulepath")?.[1];
  try {
    execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ...(psModulePath ? { PSModulePath: psModulePath } : {}),
        INSTAGRAM_MCP_PRIVATE_FS_PATH: path,
        INSTAGRAM_MCP_PRIVATE_FS_OPERATION: operation,
      },
    });
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stderr?: Buffer; status?: number; signal?: string };
    const stderr = processError.stderr?.toString("utf8") ?? "";
    const diagnostic = stderr.match(/MCP_PRIVATE_FS\|([A-Za-z]+)\|([A-Za-z]+)\|([A-Z_]+)/);
    const stageMatches = [...stderr.matchAll(/MCP_PRIVATE_FS_STAGE\|([A-Z_]+)/g)];
    const lastStage = stageMatches.at(-1)?.[1] ?? "NO_STAGE";
    const knownCodes = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT", "UNKNOWN"]);
    const code = knownCodes.has(processError.code ?? "") ? processError.code : "OTHER";
    const status = Number.isInteger(processError.status) ? String(processError.status) : "NONE";
    const details = diagnostic
      ? `${diagnostic[1]}/${diagnostic[2]}/${diagnostic[3]}`
      : `PROCESS_FAILURE/${code}/${status}/${lastStage}`;
    throw new Error(`Windows private filesystem ACL could not be verified (${details}).`);
  }
}
