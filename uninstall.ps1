[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("REMOVE-APP")][string]$Confirmation,
  [string]$Target = (Join-Path $env:LOCALAPPDATA "meta-instagram-mcp\app")
)
$ErrorActionPreference = "Stop"
$Target = [System.IO.Path]::GetFullPath($Target)
$state = Join-Path $Target ".meta-instagram-mcp-install.json"
if (-not (Test-Path -LiteralPath $state -PathType Leaf)) { throw "Managed installation not found; refusing to move this path." }
$item = Get-Item -LiteralPath $Target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing a symlink installation target." }
$archive = "$Target.uninstalled.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
if (Test-Path -LiteralPath $archive) { throw "Archive path already exists; refusing to overwrite it." }
Move-Item -LiteralPath $Target -Destination $archive
Write-Output "App archived: $archive"
Write-Output "Config and prior backups were retained."
