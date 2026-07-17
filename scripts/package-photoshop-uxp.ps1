param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Source = Join-Path $Root "integrations\photoshop-uxp"
if (!$OutputPath) {
  $OutputPath = Join-Path $Root "dist-plugins\LIclick Live Texture.ccx"
}

if (!(Test-Path -LiteralPath (Join-Path $Source "manifest.json"))) {
  throw "Photoshop UXP manifest was not found: $Source"
}

$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path $OutputPath
$TemporaryZip = [System.IO.Path]::ChangeExtension($OutputPath, ".zip")
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path -LiteralPath $TemporaryZip) { Remove-Item -LiteralPath $TemporaryZip -Force }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }

Compress-Archive -Path (Join-Path $Source "*") -DestinationPath $TemporaryZip -CompressionLevel Optimal
Move-Item -LiteralPath $TemporaryZip -Destination $OutputPath
Write-Host "Photoshop UXP package: $OutputPath" -ForegroundColor Green
