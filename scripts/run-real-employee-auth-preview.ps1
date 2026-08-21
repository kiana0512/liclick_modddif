param(
  [int]$Port = 5646,
  [string]$WorkspaceDir = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$WorkspaceDir) {
  $WorkspaceDir = Join-Path $Root ".codex-tmp\real-auth-workspace"
}

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Port must be between 1 and 65535."
}

$AtlasScript = Join-Path $env:APPDATA "npm\node_modules\@lilith\atlas-skillhub\dist\index.js"
if (!(Test-Path -LiteralPath $AtlasScript -PathType Leaf)) {
  throw "The server-side Atlas test runtime is unavailable. Install it only on the development/server simulator, never as a browser client requirement."
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

$WebDist = Join-Path $Root "apps\web\dist"
$ServerEntry = Join-Path $Root "apps\server\dist\index.js"
if (!(Test-Path -LiteralPath $WebDist -PathType Container)) {
  throw "Web build was not found: $WebDist"
}
if (!(Test-Path -LiteralPath $ServerEntry -PathType Leaf)) {
  throw "Server build was not found: $ServerEntry"
}

$SessionBytes = New-Object byte[] 48
$Random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $Random.GetBytes($SessionBytes)
} finally {
  $Random.Dispose()
}

$Origin = "http://127.0.0.1:$Port"
$env:NODE_ENV = "production"
$env:LICLICK_RUNTIME_MODE = "cloud"
$env:SERVER_HOST = "127.0.0.1"
$env:SERVER_PORT = [string]$Port
$env:LICLICK_SERVE_WEB = "true"
$env:LICLICK_WEB_DIST_DIR = $WebDist
$env:LICLICK_PUBLIC_WORKSPACE_URL = $Origin
$env:LICLICK_FRONTEND_URL = "$Origin/li3d/"
$env:LICLICK_ALLOWED_ORIGINS = $Origin
$env:LICLICK_WORKSPACE_DIR = [IO.Path]::GetFullPath($WorkspaceDir)
$env:AUTH_MODE = "feishu-oauth"
$env:LICLICK_ENABLE_ATLAS_LOCAL_LOGIN = "true"
$env:ATLAS_LOGIN_MODE = "interactive"
$env:ATLAS_SKILLHUB_PATH = $AtlasScript
$env:ATLAS_BROWSER = "echo"
$env:LICLICK_REAL_AUTH_SERVER_ENTRY = $ServerEntry
$env:SESSION_SECRET = [Convert]::ToBase64String($SessionBytes)
$env:SESSION_COOKIE_SECURE = "false"
$env:FEISHU_DIRECTORY_ENRICHMENT_ENABLED = "false"
$env:FEISHU_BITABLE_SYNC_ENABLED = "false"

# A visible preview must never silently become the OAuth mock. The mock remains
# available only through the explicit smoke/simulator commands.
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_CLIENT_ID", $null, "Process")
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_CLIENT_SECRET", $null, "Process")
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_AUTHORIZE_URL", $null, "Process")
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_TOKEN_URL", $null, "Process")
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_USERINFO_URL", $null, "Process")
[Environment]::SetEnvironmentVariable("FEISHU_OAUTH_ALLOW_LOOPBACK_PROVIDER", $null, "Process")

Write-Host "LI3D real employee-auth preview: $Origin/li3d/" -ForegroundColor Green
Write-Host "Atlas runs on this development server simulator only; the browser artifact remains zero-install." -ForegroundColor DarkGray
Write-Host "Object storage is simulated inside the development server process; no cloud account is required." -ForegroundColor DarkGray

Push-Location $Root
try {
  & node (Join-Path $Root "scripts\real-auth-preview-runner.mjs")
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
