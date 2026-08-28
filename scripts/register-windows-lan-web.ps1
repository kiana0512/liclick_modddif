param(
  [Parameter(Mandatory = $true)]
  [string]$PublicUrl,
  [string]$ListenAddress = "0.0.0.0",
  [int]$Port = 4517,
  [string]$TaskName = "LI3D LAN Web Server",
  [string]$EnvironmentFile = "",
  [switch]$SkipBuild,
  [bool]$StartNow = $true
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $Root "scripts\run-windows-lan-web.ps1"
$SecretsDir = Join-Path $Root "secrets"
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $SecretsDir "li3d-lan.env"
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
  }
}

function New-SessionSecret {
  $bytes = New-Object byte[] 48
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes)
}

function Protect-EnvironmentFile {
  param([string]$Path)

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path /inheritance:r /grant:r "SYSTEM:(R)" "BUILTIN\Administrators:(F)" "${currentUser}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict access to the LI3D environment file."
  }
}

Assert-Administrator

if (!(Test-Path -LiteralPath $Runner -PathType Leaf)) {
  throw "LI3D resident runner was not found: $Runner"
}

$PublicUri = [Uri]$PublicUrl
if ($PublicUri.Scheme -notin @("http", "https")) {
  throw "PublicUrl must use http or https: $PublicUrl"
}

New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  @(
    "# LI3D machine-local secrets. This file is gitignored and ACL protected.",
    "SESSION_SECRET=$(New-SessionSecret)",
    "FEISHU_OAUTH_CLIENT_ID=cli_aafabf458c219bfb",
    "FEISHU_OAUTH_CLIENT_SECRET=",
    "FEISHU_OAUTH_SCOPE=",
    "FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK=false",
    "LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=false"
  ) | Set-Content -LiteralPath $EnvironmentFile -Encoding UTF8
}
Protect-EnvironmentFile -Path $EnvironmentFile

if (!$SkipBuild) {
  Push-Location $Root
  try {
    & corepack pnpm --filter "@liclick/web" build
    if ($LASTEXITCODE -ne 0) { throw "LI3D web build failed with exit code $LASTEXITCODE" }
    & corepack pnpm --filter "@liclick/server" build
    if ($LASTEXITCODE -ne 0) { throw "LI3D server build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$PowerShell = Join-Path $PSHOME "powershell.exe"
$Arguments = @(
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $Runner),
  "-ListenAddress", ('"{0}"' -f $ListenAddress),
  "-Port", [string]$Port,
  "-PublicUrl", ('"{0}"' -f $PublicUri.GetLeftPart([UriPartial]::Authority)),
  "-EnvironmentFile", ('"{0}"' -f $EnvironmentFile)
) -join " "

$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "LI3D integrated Web and API server on TCP $Port" `
  -Force | Out-Null

$NodeExecutable = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
}
$FirewallRuleName = "LI3D LAN Web TCP $Port"
if (!(Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName $FirewallRuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Program $NodeExecutable `
    -Profile Domain,Private `
    -RemoteAddress LocalSubnet | Out-Null
}

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host "LI3D scheduled task: $TaskName" -ForegroundColor Green
Write-Host "Listen: $ListenAddress`:$Port"
Write-Host "URL: $($PublicUri.GetLeftPart([UriPartial]::Authority))"
Write-Host "Environment: $EnvironmentFile"
Write-Host "Firewall: $FirewallRuleName (Domain/Private, LocalSubnet only)"
