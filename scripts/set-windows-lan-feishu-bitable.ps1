param(
  [Parameter(Mandatory = $true)]
  [Security.SecureString]$AppToken,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tbl[A-Za-z0-9_-]+$')]
  [string]$TableId,
  [bool]$SyncEnabled = $true,
  [Nullable[bool]]$DirectoryEnrichmentEnabled = $null,
  [string]$EnvironmentFile = ""
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}
$EnvironmentFile = [IO.Path]::GetFullPath($EnvironmentFile)
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

function ConvertFrom-Li3dSecureString {
  param([Security.SecureString]$Value)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Set-Li3dEnvironmentValuesAtomic {
  param(
    [string]$Path,
    [Collections.Specialized.OrderedDictionary]$Updates
  )

  $bytes = [IO.File]::ReadAllBytes($Path)
  $hasUtf8Bom =
    $bytes.Length -ge 3 -and
    $bytes[0] -eq 0xEF -and
    $bytes[1] -eq 0xBB -and
    $bytes[2] -eq 0xBF
  $encoding = New-Object Text.UTF8Encoding($hasUtf8Bom)
  $content = $encoding.GetString($bytes)
  if ($hasUtf8Bom -and $content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
    $content = $content.Substring(1)
  }
  $newLine = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $hadTrailingNewLine = $content.EndsWith("`n")
  $lines = if ($content.Length -eq 0) { @() } else { @($content -split "`r?`n", -1) }
  if ($hadTrailingNewLine -and $lines.Count -gt 0 -and $lines[-1] -eq "") {
    $lines = @($lines[0..($lines.Count - 2)])
  }

  $seen = @{}
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $line = $lines[$index]
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { continue }
    $key = $Matches[1]
    if (!$Updates.Contains($key)) { continue }
    if ($seen.ContainsKey($key)) {
      throw "Duplicate environment key prevents a safe update: $key"
    }
    $seen[$key] = $true
    $lines[$index] = "$key=$($Updates[$key])"
  }
  foreach ($entry in $Updates.GetEnumerator()) {
    if (!$seen.ContainsKey($entry.Key)) {
      $lines += "$($entry.Key)=$($entry.Value)"
    }
  }

  $updatedContent = $lines -join $newLine
  if ($hadTrailingNewLine -or $updatedContent.Length -gt 0) {
    $updatedContent += $newLine
  }

  $directory = Split-Path -Parent $Path
  $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f [IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString('N'))
  $backupPath = Join-Path $directory (".{0}.{1}.bak" -f [IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($temporaryPath, $updatedContent, $encoding)
    $acl = Get-Acl -LiteralPath $Path
    Set-Acl -LiteralPath $temporaryPath -AclObject $acl
    [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
    if (Test-Path -LiteralPath $backupPath) {
      Remove-Item -LiteralPath $backupPath -Force
    }
  }
}

$plainAppToken = ConvertFrom-Li3dSecureString -Value $AppToken
try {
  if ([string]::IsNullOrWhiteSpace($plainAppToken) -or $plainAppToken -notmatch '^[A-Za-z0-9_-]+$') {
    throw "Feishu Bitable App Token has an invalid format."
  }
  if ($plainAppToken.Contains("`r") -or $plainAppToken.Contains("`n")) {
    throw "Feishu Bitable App Token must be a single line."
  }

  $updates = [ordered]@{
    FEISHU_BITABLE_SYNC_ENABLED = if ($SyncEnabled) { "true" } else { "false" }
    FEISHU_BITABLE_APP_TOKEN = $plainAppToken
    FEISHU_BITABLE_TABLE_ID = $TableId
  }
  if ($PSBoundParameters.ContainsKey('DirectoryEnrichmentEnabled')) {
    $updates['FEISHU_DIRECTORY_ENRICHMENT_ENABLED'] = if ($DirectoryEnrichmentEnabled.Value) { "true" } else { "false" }
  }

  Set-Li3dEnvironmentValuesAtomic -Path $EnvironmentFile -Updates $updates
} finally {
  $plainAppToken = $null
}

Write-Host "LI3D Feishu Bitable server settings updated atomically. Restart the resident service to apply them." -ForegroundColor Green
