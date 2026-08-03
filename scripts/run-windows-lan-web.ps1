param(
  [string]$ListenAddress = "0.0.0.0",
  [int]$Port = 4517,
  [string]$PublicUrl = "http://127.0.0.1:4517",
  [string]$EnvironmentFile = ""
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServerEntry = Join-Path $Root "apps\server\dist\index.js"
$WebIndex = Join-Path $Root "apps\web\dist\index.html"
$WebDist = Join-Path $Root "apps\web\dist"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "li3d-lan-web.pid"

if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}

function Import-Li3dEnvironmentFile {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "LI3D environment file was not found: $Path"
  }

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { continue }
    $key = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    if ($key -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
      throw "Invalid environment key in ${Path}: $key"
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

function Resolve-NodeExecutable {
  $programFilesNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path -LiteralPath $programFilesNode -PathType Leaf) {
    return $programFilesNode
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Node.js was not found. Install Node.js before starting LI3D."
}

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Port must be between 1 and 65535."
}
if (!(Test-Path -LiteralPath $ServerEntry -PathType Leaf)) {
  throw "LI3D server build was not found: $ServerEntry"
}
if (!(Test-Path -LiteralPath $WebIndex -PathType Leaf)) {
  throw "LI3D web build was not found: $WebIndex"
}

$PublicUri = [Uri]$PublicUrl
if ($PublicUri.Scheme -notin @("http", "https")) {
  throw "PublicUrl must use http or https: $PublicUrl"
}
$PublicOrigin = $PublicUri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")

Import-Li3dEnvironmentFile -Path $EnvironmentFile

# The shared LAN web service must never inherit a machine-wide Liclick/Atlas
# credential. Image generation is authenticated by each employee's loopback
# local component instead.
[Environment]::SetEnvironmentVariable("ATLAS_TOKEN_FILE", $null, "Process")

$LoopbackOrigins = @(
  "http://127.0.0.1:$Port",
  "http://localhost:$Port"
)
$ConfiguredOrigins = @($PublicOrigin) + $LoopbackOrigins
if ($env:LICLICK_ALLOWED_ORIGINS) {
  $ConfiguredOrigins += $env:LICLICK_ALLOWED_ORIGINS.Split(",", [StringSplitOptions]::RemoveEmptyEntries)
}

$env:NODE_ENV = "production"
$env:SERVER_HOST = $ListenAddress
$env:SERVER_PORT = [string]$Port
$env:LICLICK_WORKSPACE_HOST = $ListenAddress
$env:LICLICK_WORKSPACE_PORT = [string]$Port
$env:LICLICK_SERVE_WEB = "true"
$env:LICLICK_WEB_DIST_DIR = $WebDist
$env:LICLICK_PUBLIC_WORKSPACE_URL = $PublicOrigin
$env:LICLICK_FRONTEND_URL = $PublicOrigin
$env:LICLICK_ALLOWED_ORIGINS = ($ConfiguredOrigins | ForEach-Object { $_.Trim().TrimEnd("/") } | Where-Object { $_ } | Select-Object -Unique) -join ","
$env:FEISHU_OAUTH_REDIRECT_URL = "$PublicOrigin/api/auth/feishu/callback"
$env:AUTH_MODE = "feishu-oauth"
$env:LICLICK_ENABLE_ATLAS_LOCAL_LOGIN = "false"
$env:SESSION_COOKIE_SECURE = if ($PublicUri.Scheme -eq "https") { "true" } else { "false" }
if (
  $PublicUri.Scheme -ne "https" -and
  $PublicUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]") -and
  $env:FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK -ne "true"
) {
  # Keep the credential safely persisted for the eventual HTTPS origin, but
  # never activate OAuth over clear-text LAN HTTP.
  [Environment]::SetEnvironmentVariable("FEISHU_OAUTH_CLIENT_SECRET", $null, "Process")
}
if (!$env:LICLICK_WORKSPACE_DIR) {
  $env:LICLICK_WORKSPACE_DIR = Join-Path $Root "workspace"
}

$NodeExecutable = Resolve-NodeExecutable
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Date = Get-Date -Format "yyyy-MM-dd"
$StdoutLog = Join-Path $LogDir "li3d-lan-web-$Date.log"
$StderrLog = Join-Path $LogDir "li3d-lan-web-$Date.err.log"

Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII
Push-Location $Root
try {
  while ($true) {
    $ExitCode = 1
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5.1 converts native stderr into NativeCommandError
      # records. Keep those records in the error log without treating ordinary
      # Node diagnostics as a fatal supervisor failure.
      $ErrorActionPreference = "Continue"
      & $NodeExecutable $ServerEntry 1>> $StdoutLog 2>> $StderrLog
      if ($null -ne $LASTEXITCODE) { $ExitCode = $LASTEXITCODE }
    } finally {
      $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($null -eq $ExitCode) { $ExitCode = 1 }
    $Timestamp = (Get-Date).ToString("o")
    "[$Timestamp] LI3D Node process exited with code $ExitCode; restarting in 5 seconds." |
      Out-File -LiteralPath $StderrLog -Append -Encoding UTF8
    Start-Sleep -Seconds 5
  }
} catch {
  $_ | Out-File -LiteralPath $StderrLog -Append -Encoding UTF8
  exit 1
} finally {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Pop-Location
}
