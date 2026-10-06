[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Revision,
  [string]$SourceDir = $PSScriptRoot,
  [string]$Target = (Join-Path $env:LOCALAPPDATA "meta-instagram-mcp\app"),
  [string]$ConfigDir = (Join-Path $env:USERPROFILE ".config\meta-instagram-mcp")
)

$ErrorActionPreference = "Stop"

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COMMAND_FAILED_$Command" }
}

function Protect-PrivatePath([string]$Path, [bool]$Directory) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = if ($Directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($Revision -notmatch '^[A-Fa-f0-9]{40}$') { throw "Pass a full 40-character commit SHA with -Revision." }
foreach ($command in @("git", "node", "npm", "tar")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is missing: $command" }
}
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required." }

$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
$Target = [System.IO.Path]::GetFullPath($Target)
$ConfigDir = [System.IO.Path]::GetFullPath($ConfigDir)
$actualRevision = (& git -C $SourceDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualRevision -ine $Revision) { throw "Source HEAD does not match -Revision." }
$dirty = & git -C $SourceDir status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Source checkout has local changes; use a clean release checkout." }
$trackedEnv = & git -C $SourceDir ls-tree -r --name-only $actualRevision -- .env
if ($LASTEXITCODE -ne 0 -or $trackedEnv) { throw "Refusing a source revision that tracks .env." }
if ($Target -eq [System.IO.Path]::GetPathRoot($Target)) { throw "Refusing an unsafe installation target." }
Invoke-Checked "node" @((Join-Path $SourceDir "tools/guard-install-paths.mjs"), $Target, $ConfigDir)

$parent = Split-Path -Parent $Target
$name = Split-Path -Leaf $Target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
if (Test-Path -LiteralPath $Target) {
  $targetItem = Get-Item -LiteralPath $Target -Force
  if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing a symlink installation target." }
  if (-not (Test-Path -LiteralPath (Join-Path $Target ".meta-instagram-mcp-install.json") -PathType Leaf)) {
    throw "Target exists but is not managed by this installer; move it or choose another -Target."
  }
}

$stage = Join-Path $parent (".{0}.stage.{1}" -f $name, [guid]::NewGuid().ToString("N"))
$archive = "$stage.tar"
$backup = $null
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Invoke-Checked "git" @("-C", $SourceDir, "archive", "--format=tar", "-o", $archive, $actualRevision)
  Invoke-Checked "tar" @("-xf", $archive, "-C", $stage)
  foreach ($required in @("package.json", "package-lock.json", ".env.example")) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Selected revision is missing required package files." }
  }

  Push-Location $stage
  try {
    Invoke-Checked "npm" @("ci", "--no-audit", "--no-fund")
    Invoke-Checked "npm" @("run", "build")
  } finally { Pop-Location }

  if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Protect-PrivatePath $ConfigDir $true
  }
  $envPath = Join-Path $ConfigDir ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    $sourceEnv = Join-Path $SourceDir ".env"
    if (Test-Path -LiteralPath $sourceEnv -PathType Leaf) { Copy-Item -LiteralPath $sourceEnv -Destination $envPath }
    else { Copy-Item -LiteralPath (Join-Path $stage ".env.example") -Destination $envPath }
    Protect-PrivatePath $envPath $false
  }

  $package = Get-Content -LiteralPath (Join-Path $stage "package.json") -Raw | ConvertFrom-Json
  $state = [ordered]@{ revision = $actualRevision.ToLowerInvariant(); version = $package.version; installedAt = [DateTime]::UtcNow.ToString("o") }
  $statePath = Join-Path $stage ".meta-instagram-mcp-install.json"
  [IO.File]::WriteAllText($statePath, (($state | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))

  if (Test-Path -LiteralPath $Target) {
    $backup = Join-Path $parent ("{0}.backup.{1}.{2}" -f $name, [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"), $actualRevision.Substring(0, 8))
    if (Test-Path -LiteralPath $backup) { throw "Backup path already exists; refusing to overwrite it." }
    Move-Item -LiteralPath $Target -Destination $backup
  }
  try { Move-Item -LiteralPath $stage -Destination $Target }
  catch {
    if ($backup -and -not (Test-Path -LiteralPath $Target)) { Move-Item -LiteralPath $backup -Destination $Target }
    throw "Promotion failed; the previous installation was restored when available."
  }
  Write-Output "Installed revision $actualRevision"
  Write-Output "App: $Target"
  Write-Output "Config: $ConfigDir"
  if ($backup) { Write-Output "Previous install backup: $backup" }
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
