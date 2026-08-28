param(
  [switch]$Disable,
  [string]$EnvironmentFile = "",
  [string]$TaskName = "LI3D LAN Web Server"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

function Protect-EnvironmentFile {
  param([string]$Path)

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path /inheritance:r /grant:r "SYSTEM:(R)" "BUILTIN\Administrators:(F)" "${currentUser}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict access to the LI3D environment file."
  }
}

$Values = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
}

$Enabled = !$Disable
$Values["FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK"] = if ($Enabled) { "true" } else { "false" }
$Output = @("# LI3D machine-local secrets. This file is gitignored and ACL protected.")
foreach ($entry in $Values.GetEnumerator()) {
  $Output += "$($entry.Key)=$($entry.Value)"
}
[IO.File]::WriteAllLines($EnvironmentFile, $Output, (New-Object Text.UTF8Encoding($false)))
Protect-EnvironmentFile -Path $EnvironmentFile

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host "LI3D temporary LAN HTTP OAuth: $Enabled" -ForegroundColor Yellow
