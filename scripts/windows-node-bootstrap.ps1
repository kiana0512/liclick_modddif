param(
  [string]$NodeVersion = "22.13.1"
)

$ErrorActionPreference = "Stop"

$AppDataRoot = Join-Path $env:LOCALAPPDATA "Liclick 3D Texture"
$DownloadDir = Join-Path $AppDataRoot "downloads"
$NodeDir = Join-Path $AppDataRoot "node"
$NodeExe = Join-Path $NodeDir "node.exe"

if (Test-Path $NodeExe) {
  Write-Host "Node is already installed at $NodeExe"
  exit 0
}

New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
New-Item -ItemType Directory -Force -Path $AppDataRoot | Out-Null

$ZipPath = Join-Path $DownloadDir "node-v$NodeVersion-win-x64.zip"
$ExtractRoot = Join-Path $DownloadDir "node-extract"
$Url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

Write-Host ""
Write-Host "Liclick 3D Texture needs Node.js to start local services."
Write-Host "Downloading Node.js $NodeVersion. First launch may take a while."
Write-Host "URL: $Url"
Write-Host ""

if (!(Test-Path $ZipPath)) {
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath
}

if (Test-Path $ExtractRoot) {
  Remove-Item -LiteralPath $ExtractRoot -Recurse -Force
}
Expand-Archive -Path $ZipPath -DestinationPath $ExtractRoot -Force

$Inner = Get-ChildItem -Path $ExtractRoot -Directory | Select-Object -First 1
if (!$Inner) {
  throw "Could not find extracted Node.js directory."
}

if (Test-Path $NodeDir) {
  Remove-Item -LiteralPath $NodeDir -Recurse -Force
}
Move-Item -Path $Inner.FullName -Destination $NodeDir
Remove-Item -LiteralPath $ExtractRoot -Recurse -Force

if (!(Test-Path $NodeExe)) {
  throw "Node.js installation failed: $NodeExe was not created."
}

Write-Host "Node.js is ready: $NodeExe"
