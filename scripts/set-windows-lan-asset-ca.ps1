param(
  [Parameter(Mandatory = $true)]
  [string]$CertificatePath,
  [string]$AssetServiceBaseUrl = "https://10.3.34.11",
  [string]$EnvironmentFile = "",
  [string]$TaskName = "LI3D LAN Web Server",
  [bool]$RestartTask = $true
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}

$ResolvedCertificatePath = (Resolve-Path -LiteralPath $CertificatePath).Path
if (!(Test-Path -LiteralPath $ResolvedCertificatePath -PathType Leaf)) {
  throw "Asset service CA certificate was not found: $CertificatePath"
}
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

$Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  $ResolvedCertificatePath
)
if ($Certificate.HasPrivateKey) {
  throw "The Asset service CA file must not contain a private key."
}
$BasicConstraintsExtension = $Certificate.Extensions |
  Where-Object { $_.Oid.Value -eq "2.5.29.19" } |
  Select-Object -First 1
if (!$BasicConstraintsExtension) {
  throw "The Asset service certificate does not contain CA basic constraints."
}
$BasicConstraints = New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension
$BasicConstraints.CopyFrom($BasicConstraintsExtension)
if (!$BasicConstraints.CertificateAuthority) {
  throw "The Asset service certificate is not a CA certificate."
}
$Now = Get-Date
if ($Now -lt $Certificate.NotBefore -or $Now -gt $Certificate.NotAfter) {
  throw "The Asset service CA certificate is not currently valid."
}

$BaseUri = [Uri]$AssetServiceBaseUrl
if ($BaseUri.Scheme -ne "https") {
  throw "Asset Service must use an HTTPS base URL."
}

$Values = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
}
$Values["ASSET_SERVICE_BASE_URL"] = $BaseUri.AbsoluteUri.TrimEnd("/")
$Values["ASSET_SERVICE_CA_CERT_PATH"] = $ResolvedCertificatePath
$Values["ASSET_SERVICE_TLS_REJECT_UNAUTHORIZED"] = "true"

$Output = @("# LI3D machine-local secrets. This file is gitignored and ACL protected.")
foreach ($entry in $Values.GetEnumerator()) {
  $Output += "$($entry.Key)=$($entry.Value)"
}
[IO.File]::WriteAllLines($EnvironmentFile, $Output, (New-Object Text.UTF8Encoding($false)))

if ($RestartTask) {
  $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($Task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    $Deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $Task = Get-ScheduledTask -TaskName $TaskName
    } while ($Task.State -ne "Ready" -and (Get-Date) -lt $Deadline)
    if ($Task.State -ne "Ready") {
      throw "LI3D scheduled task did not stop before restart."
    }
  }
  Start-ScheduledTask -TaskName $TaskName
  $Deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $Task = Get-ScheduledTask -TaskName $TaskName
  } while ($Task.State -ne "Running" -and (Get-Date) -lt $Deadline)
  if ($Task.State -ne "Running") {
    throw "LI3D scheduled task did not remain running after restart."
  }
}

Write-Host "LI3D Asset service CA configured: $ResolvedCertificatePath" -ForegroundColor Green
Write-Host "Certificate thumbprint: $($Certificate.Thumbprint)" -ForegroundColor Green
