param(
  [int]$Port = 4517,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvironmentFile = Join-Path $Root "secrets\li3d-dev.env"

function Import-EnvironmentFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (!$line -or $line.StartsWith("#")) { continue }
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { continue }
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)
    Set-Item -LiteralPath ("Env:" + $key) -Value $value
  }
}

if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "Real Feishu configuration was not found: $EnvironmentFile"
}

if (!$SkipBuild) {
  Push-Location $Root
  try {
    & corepack pnpm --filter @liclick/server build
    if ($LASTEXITCODE -ne 0) { throw "Server build failed." }
    & corepack pnpm --filter @liclick/web build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
  } finally {
    Pop-Location
  }
}

Import-EnvironmentFile -Path $EnvironmentFile

# Local acceptance is one integrated backend. Clear external object-storage
# configuration so uploads stay inside the authenticated 4517 workspace.
$CloudStorageVariables = @(
  "LICLICK_OBJECT_STORAGE_ENDPOINT",
  "LICLICK_OBJECT_STORAGE_REGION",
  "LICLICK_OBJECT_STORAGE_BUCKET",
  "LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID",
  "LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "LICLICK_OBJECT_STORAGE_SESSION_TOKEN"
)
foreach ($Name in $CloudStorageVariables) {
  [Environment]::SetEnvironmentVariable($Name, $null, "Process")
}

$Origin = "http://127.0.0.1:$Port"
$env:NODE_ENV = "production"
$env:SERVER_HOST = "127.0.0.1"
$env:SERVER_PORT = [string]$Port
$env:LICLICK_WORKSPACE_PORT = [string]$Port
$env:LICLICK_SERVE_WEB = "true"
$env:LICLICK_WEB_DIST_DIR = Join-Path $Root "apps\web\dist"
$env:LICLICK_PUBLIC_WORKSPACE_URL = $Origin
$env:LICLICK_FRONTEND_URL = "$Origin/"
$env:LICLICK_ALLOWED_ORIGINS = $Origin
$env:LICLICK_WORKSPACE_DIR = Join-Path $Root "workspace"
$env:AUTH_MODE = "feishu-oauth"
$env:LICLICK_ENABLE_ATLAS_LOCAL_LOGIN = "false"
$env:FEISHU_OAUTH_REDIRECT_URL = "$Origin/api/auth/feishu/callback"
$env:SESSION_COOKIE_SECURE = "false"

Write-Host "LI3D real local preview: $Origin/" -ForegroundColor Green
Write-Host "Authentication: real Feishu OAuth" -ForegroundColor Green
Write-Host "Assets: integrated 4517 workspace (no local component)" -ForegroundColor Green

Push-Location $Root
try {
  & node (Join-Path $Root "apps\server\dist\index.js")
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
