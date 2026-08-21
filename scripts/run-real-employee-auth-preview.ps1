param(
  [int]$Port = 5646,
  [string]$WorkspaceDir = "",
  [switch]$SkipBuild,
  [switch]$UseConfiguredAssetService
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PublicPath = "/li3d"
$env:VITE_PUBLIC_PATH = $PublicPath
$env:LICLICK_PUBLIC_PATH = $PublicPath

function ConvertTo-PemBlock {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $Base64 = [Convert]::ToBase64String(
    $Bytes,
    [Base64FormattingOptions]::InsertLineBreaks
  )
  return "-----BEGIN $Label-----`r`n$Base64`r`n-----END $Label-----`r`n"
}
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
$WebIndex = Join-Path $WebDist "index.html"
if (!(Test-Path -LiteralPath $WebIndex -PathType Leaf)) {
  throw "Web index was not found: $WebIndex"
}
$WebIndexContent = Get-Content -LiteralPath $WebIndex -Raw
if (!$WebIndexContent.Contains("src=`"$PublicPath/assets/")) {
  throw "Web build public path does not match $PublicPath. Run the preview without -SkipBuild."
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
$env:LICLICK_FRONTEND_URL = "$Origin$PublicPath/"
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

if (!$UseConfiguredAssetService) {
  $AssetTlsDir = Join-Path $env:LICLICK_WORKSPACE_DIR "asset-service-simulator-tls"
  New-Item -ItemType Directory -Path $AssetTlsDir -Force | Out-Null
  $AssetCaPath = Join-Path $AssetTlsDir "ca.pem"
  $AssetPfxPath = Join-Path $AssetTlsDir "server.pfx"
  $AssetPfxPassphrase = "liclick-preview-asset-pfx"

  $CaRsa = [Security.Cryptography.RSA]::Create(2048)
  $LeafRsa = [Security.Cryptography.RSA]::Create(2048)
  $CaCertificate = $null
  $LeafCertificateWithoutKey = $null
  $LeafCertificate = $null
  try {
    $CaRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=Liclick Preview Asset CA",
      $CaRsa,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $CaRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
    )
    $CaRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
          [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,
        $true
      )
    )
    $CaRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($CaRequest.PublicKey, $false)
    )
    $NotBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $NotAfter = [DateTimeOffset]::UtcNow.AddDays(7)
    $CaCertificate = $CaRequest.CreateSelfSigned($NotBefore, $NotAfter)

    $LeafRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=127.0.0.1",
      $LeafRsa,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $LeafRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
    )
    $LeafRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
          [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
        $true
      )
    )
    $EnhancedUsages = [Security.Cryptography.OidCollection]::new()
    [void]$EnhancedUsages.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $LeafRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($EnhancedUsages, $true)
    )
    $SubjectAlternativeNames = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $SubjectAlternativeNames.AddIpAddress([Net.IPAddress]::Parse("127.0.0.1"))
    $SubjectAlternativeNames.AddDnsName("localhost")
    $LeafRequest.CertificateExtensions.Add($SubjectAlternativeNames.Build())
    $LeafRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($LeafRequest.PublicKey, $false)
    )
    $Serial = New-Object byte[] 16
    $SerialRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $SerialRandom.GetBytes($Serial)
    } finally {
      $SerialRandom.Dispose()
    }
    $Serial[0] = $Serial[0] -band 0x7f
    $LeafCertificateWithoutKey = $LeafRequest.Create($CaCertificate, $NotBefore, $NotAfter, $Serial)
    $LeafCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey(
      $LeafCertificateWithoutKey,
      $LeafRsa
    )

    $CaDer = $CaCertificate.Export(
      [Security.Cryptography.X509Certificates.X509ContentType]::Cert
    )
    [IO.File]::WriteAllText(
      $AssetCaPath,
      (ConvertTo-PemBlock -Bytes $CaDer -Label "CERTIFICATE"),
      [Text.Encoding]::ASCII
    )
    [IO.File]::WriteAllBytes(
      $AssetPfxPath,
      $LeafCertificate.Export(
        [Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
        $AssetPfxPassphrase
      )
    )
  } finally {
    if ($LeafCertificate) { $LeafCertificate.Dispose() }
    if ($LeafCertificateWithoutKey) { $LeafCertificateWithoutKey.Dispose() }
    if ($CaCertificate) { $CaCertificate.Dispose() }
    $LeafRsa.Dispose()
    $CaRsa.Dispose()
  }

  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_CERT_PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_KEY_PATH", $null, "Process")
  $env:LICLICK_ASSET_SIMULATOR_PFX_PATH = $AssetPfxPath
  $env:LICLICK_ASSET_SIMULATOR_PFX_PASSPHRASE = $AssetPfxPassphrase
  $env:ASSET_SERVICE_CA_CERT_PATH = $AssetCaPath
  $env:ASSET_SERVICE_CA_CERT_SHA256 = (Get-FileHash -LiteralPath $AssetCaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $env:ASSET_SERVICE_TLS_REJECT_UNAUTHORIZED = "true"
  $env:ASSET_SERVICE_API_TOKEN = "liclick-preview-asset-token"
} else {
  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_CERT_PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_KEY_PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_PFX_PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("LICLICK_ASSET_SIMULATOR_PFX_PASSPHRASE", $null, "Process")
}

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
if (!$UseConfiguredAssetService) {
  Write-Host "Automatic retopology uses an HTTPS simulator with a generated, SHA-pinned test CA." -ForegroundColor DarkGray
}

Push-Location $Root
try {
  & node (Join-Path $Root "scripts\real-auth-preview-runner.mjs")
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
