[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$Target = (Join-Path $env:LOCALAPPDATA "meta-instagram-mcp\app")
)
$ErrorActionPreference = "Stop"
$Target = [System.IO.Path]::GetFullPath($Target)
$Backup = [System.IO.Path]::GetFullPath($Backup)
if ($Target -ieq $Backup) { throw "Target and backup must be different paths." }
foreach ($path in @($Target, $Backup)) {
  if (-not (Test-Path -LiteralPath (Join-Path $path ".meta-instagram-mcp-install.json") -PathType Leaf)) {
    throw "Both paths must be managed installer directories."
  }
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing a symlink path." }
}
$rollbackCopy = "$Target.rollback.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
if (Test-Path -LiteralPath $rollbackCopy) { throw "Rollback backup path already exists; refusing to overwrite it." }
Move-Item -LiteralPath $Target -Destination $rollbackCopy
try { Move-Item -LiteralPath $Backup -Destination $Target }
catch {
  Move-Item -LiteralPath $rollbackCopy -Destination $Target
  throw "Rollback failed; the current installation was restored."
}
Write-Output "Restored backup: $Backup"
Write-Output "Previous install retained: $rollbackCopy"
