param(
  [Parameter(Mandatory = $true)]
  [string]$AtlasSkillhubPath,
  [string]$EnvironmentFile = "",
  [string]$TaskName = "LI3D LAN Web Server",
  [bool]$RestartTask = $true
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}

$ResolvedAtlasPath = (Resolve-Path -LiteralPath $AtlasSkillhubPath).Path
if (!(Test-Path -LiteralPath $ResolvedAtlasPath -PathType Leaf)) {
  throw "Atlas Skill Hub runtime was not found: $AtlasSkillhubPath"
}
if ([IO.Path]::GetFileName($ResolvedAtlasPath) -ne "index.js") {
  throw "Atlas Skill Hub runtime must point to dist\index.js."
}
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

$Values = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
}
$Values["ATLAS_SKILLHUB_PATH"] = $ResolvedAtlasPath

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
}

Write-Host "LI3D Atlas runtime path configured: $ResolvedAtlasPath" -ForegroundColor Green
