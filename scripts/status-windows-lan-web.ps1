param(
  [string]$TaskName = "LI3D LAN Web Server",
  [int]$Port = 4517,
  [string]$PublicUrl = "http://127.0.0.1:4517"
)

$ErrorActionPreference = "SilentlyContinue"

$Task = Get-ScheduledTask -TaskName $TaskName
$TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
$Listeners = Get-NetTCPConnection -State Listen -LocalPort $Port
$Health = $null
try {
  $Health = Invoke-RestMethod -Uri "$($PublicUrl.TrimEnd('/'))/api/health" -TimeoutSec 3
} catch {}

[PSCustomObject]@{
  TaskName = $TaskName
  TaskState = if ($Task) { [string]$Task.State } else { "Missing" }
  LastTaskResult = if ($TaskInfo) { $TaskInfo.LastTaskResult } else { $null }
  Listening = [bool]$Listeners
  ListenAddresses = @($Listeners | Select-Object -ExpandProperty LocalAddress -Unique)
  Port = $Port
  Healthy = [bool]$Health.ok
  IntegratedWeb = [bool]$Health.features.integratedWeb
  Url = $PublicUrl
} | ConvertTo-Json -Depth 4
