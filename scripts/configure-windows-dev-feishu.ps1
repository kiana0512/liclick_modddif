param(
  [string]$AppId = "cli_aafabf458c219bfb",
  [string]$EnvironmentFile = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-dev.env"
}

function New-SessionSecret {
  $bytes = New-Object byte[] 48
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes)
}

$SecureSecret = Read-Host "Feishu Platform App Secret" -AsSecureString
$SecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
try {
  $PlainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($SecretPointer)
  if ([string]::IsNullOrWhiteSpace($PlainSecret) -or $PlainSecret.Length -lt 16) {
    throw "Feishu Platform App Secret is empty or unexpectedly short."
  }
  if ($PlainSecret.Contains("`r") -or $PlainSecret.Contains("`n")) {
    throw "Feishu Platform App Secret must be a single line."
  }

  $Values = [ordered]@{}
  if (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
      $trimmed = $line.Trim()
      if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
      $separator = $trimmed.IndexOf("=")
      if ($separator -lt 1) { continue }
      $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
    }
  }
  if (!$Values.Contains("SESSION_SECRET")) { $Values["SESSION_SECRET"] = New-SessionSecret }
  $Values["AUTH_MODE"] = "feishu-oauth"
  $Values["LICLICK_ENABLE_ATLAS_LOCAL_LOGIN"] = "true"
  $Values["FEISHU_PLATFORM_APP_ID"] = $AppId
  $Values["FEISHU_PLATFORM_APP_SECRET"] = $PlainSecret
  $Values["FEISHU_DIRECTORY_ENRICHMENT_ENABLED"] = "true"

  $directory = Split-Path -Parent $EnvironmentFile
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $Output = @("# LI3D local-development secrets. This file is gitignored.")
  foreach ($entry in $Values.GetEnumerator()) {
    $Output += "$($entry.Key)=$($entry.Value)"
  }
  [IO.File]::WriteAllLines($EnvironmentFile, $Output, (New-Object Text.UTF8Encoding($false)))

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $EnvironmentFile /inheritance:r /grant:r "SYSTEM:(R)" "BUILTIN\Administrators:(F)" "${currentUser}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to the LI3D development secret file." }
} finally {
  if ($SecretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($SecretPointer)
  }
  $PlainSecret = $null
}

Write-Host "LI3D local Feishu avatar enrichment is configured." -ForegroundColor Green
Write-Host "Restart with: corepack pnpm dev"
