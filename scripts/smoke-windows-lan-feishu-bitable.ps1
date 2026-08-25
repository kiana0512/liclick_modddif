param(
  [string]$BaseUrl = "http://127.0.0.1:4517",
  [string]$WorkspaceDirectory = "",
  [int]$TimeoutSeconds = 5
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$WorkspaceDirectory) {
  $WorkspaceDirectory = Join-Path $Root "workspace"
}
$aggregateFile = Join-Path ([IO.Path]::GetFullPath($WorkspaceDirectory)) "telemetry\daily-aggregates.json"

$result = [ordered]@{
  ok = $false
  health = [ordered]@{
    reachable = $false
    service_ok = $false
    integrated_web = $false
    identity_binding = $false
    usage_telemetry = $false
    feishu_bitable_sync = $false
  }
  aggregate_sync = [ordered]@{
    store_present = $false
    store_valid = $false
    total = 0
    pending = 0
    synced = 0
    failed = 0
  }
  checks = @()
}

try {
  $baseUri = [Uri]$BaseUrl
  if ($baseUri.Scheme -notin @('http', 'https')) {
    throw "BaseUrl must use http or https."
  }
  $healthUri = "$($BaseUrl.TrimEnd('/'))/api/health"
  $health = Invoke-RestMethod -Method Get -Uri $healthUri -TimeoutSec $TimeoutSeconds
  $result.health.reachable = $true
  $result.health.service_ok = [bool]$health.ok
  $result.health.integrated_web = [bool]$health.features.integratedWeb
  $result.health.identity_binding = [bool]$health.features.identityBinding
  $result.health.usage_telemetry = [bool]$health.features.usageTelemetry
  $result.health.feishu_bitable_sync = [bool]$health.features.feishuBitableSync
} catch {
  $result.checks += 'health_unavailable_or_invalid'
}

if (Test-Path -LiteralPath $aggregateFile -PathType Leaf) {
  $result.aggregate_sync.store_present = $true
  try {
    $document = Get-Content -LiteralPath $aggregateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $aggregates = if ($null -eq $document.aggregates) { @() } else { @($document.aggregates) }
    $result.aggregate_sync.store_valid = $true
    $result.aggregate_sync.total = $aggregates.Count
    $result.aggregate_sync.pending = @($aggregates | Where-Object { $_.sync_pending -eq $true }).Count
    $result.aggregate_sync.synced = @($aggregates | Where-Object { $_.sync_pending -eq $false -and $_.synced_at }).Count
    $result.aggregate_sync.failed = @($aggregates | Where-Object { $_.sync_pending -eq $true -and $_.sync_error }).Count
  } catch {
    $result.checks += 'aggregate_store_invalid'
  }
} else {
  $result.checks += 'aggregate_store_missing'
}

if (!$result.health.feishu_bitable_sync) {
  $result.checks += 'feishu_bitable_sync_disabled'
}
if ($result.aggregate_sync.failed -gt 0) {
  $result.checks += 'aggregate_sync_failures_present'
}

$result.ok =
  $result.health.reachable -and
  $result.health.service_ok -and
  $result.health.feishu_bitable_sync -and
  $result.aggregate_sync.store_valid -and
  $result.aggregate_sync.failed -eq 0

$result | ConvertTo-Json -Depth 5
if (!$result.ok) { exit 1 }
