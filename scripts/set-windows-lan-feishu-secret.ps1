param(
  [string]$ClientId = "cli_aafabf458c219bfb",
  [string]$EnvironmentFile = "",
  [string]$TaskName = "LI3D LAN Web Server",
  [bool]$RestartTask = $true
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

$SecureSecret = Read-Host "Feishu App Secret" -AsSecureString
$SecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
try {
  $PlainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($SecretPointer)
  if ([string]::IsNullOrWhiteSpace($PlainSecret) -or $PlainSecret.Length -lt 16) {
    throw "Feishu App Secret is empty or unexpectedly short."
  }
  if ($PlainSecret.Contains("`r") -or $PlainSecret.Contains("`n")) {
    throw "Feishu App Secret must be a single line."
  }

  $Values = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { continue }
    $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
  }
  $Values["FEISHU_OAUTH_CLIENT_ID"] = $ClientId
  $Values["FEISHU_OAUTH_CLIENT_SECRET"] = $PlainSecret

  $Output = @("# LI3D machine-local secrets. This file is gitignored and ACL protected.")
  foreach ($entry in $Values.GetEnumerator()) {
    $Output += "$($entry.Key)=$($entry.Value)"
  }
  [IO.File]::WriteAllLines($EnvironmentFile, $Output, (New-Object Text.UTF8Encoding($false)))
} finally {
  if ($SecretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($SecretPointer)
  }
  $PlainSecret = $null
}

if ($RestartTask -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host "Feishu OAuth credentials updated for LI3D." -ForegroundColor Green
