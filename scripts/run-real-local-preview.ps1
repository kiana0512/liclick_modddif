param(
  [int]$Port = 4517,
  [switch]$SkipBuild,
  [switch]$TraceTiming
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

function Resolve-AtlasRuntime {
  $Candidates = @(
    $env:ATLAS_SKILLHUB_PATH,
    (Join-Path $env:APPDATA "npm\node_modules\@lilith\atlas-skillhub\dist\index.js")
  ) | Where-Object { $_ }

  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  throw "Atlas Skillhub runtime was not found. Install @lilith/atlas-skillhub before starting real local preview."
}

function Read-AtlasStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$TokenFile
  )

  # Atlas currently prints a valid status document before Node 24 on Windows
  # aborts while closing an async handle. Capture stdout independently so a
  # valid credential is not rejected only because the child cleanup failed.
  $NodeExecutable = (Get-Command node -ErrorAction Stop).Source
  $StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $StartInfo.FileName = $NodeExecutable
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  # Windows PowerShell 5.1 does not expose ProcessStartInfo.ArgumentList.
  # These paths are resolved locally and quoted before being passed to Node.
  $EscapedRuntime = $Runtime.Replace('"', '\"')
  $EscapedTokenFile = $TokenFile.Replace('"', '\"')
  $StartInfo.Arguments = '"' + $EscapedRuntime + '" gateway status --token-file "' + $EscapedTokenFile + '"'

  $Process = [Diagnostics.Process]::new()
  $Process.StartInfo = $StartInfo
  try {
    $Process.Start() | Out-Null
    $StatusText = $Process.StandardOutput.ReadToEnd()
    $ErrorText = $Process.StandardError.ReadToEnd()
    $Process.WaitForExit()
  } finally {
    $Process.Dispose()
  }
  if (!$StatusText) { return $null }
  $StatusText = $StatusText.Trim()
  try {
    return $StatusText | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Ensure-AtlasGenerationCredential {
  $Runtime = Resolve-AtlasRuntime
  $TokenFile = if ($env:ATLAS_TOKEN_FILE) {
    $env:ATLAS_TOKEN_FILE
  } else {
    Join-Path $env:USERPROFILE ".atlas-ai-gateway-oauth.json"
  }
  $Status = Read-AtlasStatus -Runtime $Runtime -TokenFile $TokenFile

  if (!$Status -or !$Status.valid) {
    Write-Host "Generation credential is missing or expired. Opening real Atlas/Liclick authorization..." -ForegroundColor Yellow
    & node $Runtime gateway login --token-file $TokenFile
    if ($LASTEXITCODE -ne 0) { throw "Atlas/Liclick authorization failed." }
    $Status = Read-AtlasStatus -Runtime $Runtime -TokenFile $TokenFile
  }

  if (!$Status -or !$Status.valid) {
    throw "Atlas/Liclick generation credential is still invalid after authorization."
  }

  $env:ATLAS_SKILLHUB_PATH = $Runtime
  $env:ATLAS_TOKEN_FILE = $TokenFile
  Write-Host "Generation gateway: real Atlas credential valid until $($Status.expires_at)" -ForegroundColor Green
}

if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "Real Feishu configuration was not found: $EnvironmentFile"
}

$env:LI3D_DEBUG_BUILD = if ($TraceTiming) { "true" } else { "false" }
$env:VITE_LICLICK_PIPELINE_TRACE_ENABLED = "false"

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

$TraceBuildFile = Join-Path $Root "apps\web\dist\trace-build.json"
if (!(Test-Path -LiteralPath $TraceBuildFile)) { throw "Missing trace build identity; rebuild without --SkipBuild." }
$TraceBuild = Get-Content -LiteralPath $TraceBuildFile -Raw | ConvertFrom-Json
if ($TraceBuild.enabled -ne [bool]$TraceTiming) { throw "Trace build mode mismatch; rebuild without --SkipBuild." }

Import-EnvironmentFile -Path $EnvironmentFile
Ensure-AtlasGenerationCredential

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
