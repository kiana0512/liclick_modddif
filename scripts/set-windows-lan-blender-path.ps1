param(
  [Parameter(Mandatory = $true)]
  [string]$BlenderExecutablePath,
  [string]$EnvironmentFile = "",
  [string]$TaskName = "LI3D LAN Web Server",
  [bool]$RestartTask = $true
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$EnvironmentFile) {
  $EnvironmentFile = Join-Path $Root "secrets\li3d-lan.env"
}

$ResolvedBlenderPath = (Resolve-Path -LiteralPath $BlenderExecutablePath).Path
if (!(Test-Path -LiteralPath $ResolvedBlenderPath -PathType Leaf)) {
  throw "Blender executable was not found: $BlenderExecutablePath"
}
if ([IO.Path]::GetFileName($ResolvedBlenderPath) -ne "blender.exe") {
  throw "BlenderExecutablePath must point to blender.exe."
}
if (!(Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "LI3D environment file was not found: $EnvironmentFile"
}

$VersionOutput = & $ResolvedBlenderPath --version 2>&1
if ($LASTEXITCODE -ne 0 -or !$VersionOutput) {
  throw "Blender could not be started: $ResolvedBlenderPath"
}
$VersionLine = [string]($VersionOutput | Select-Object -First 1)
if ($VersionLine -notmatch '^Blender\s+(\d+)\.(\d+)(?:\.(\d+))?') {
  throw "Could not determine Blender version from: $VersionLine"
}
$Major = [int]$Matches[1]
$Minor = [int]$Matches[2]
if ($Major -ne 4 -and !($Major -eq 5 -and $Minor -le 1)) {
  throw "Blender $Major.$Minor is not compatible with the Blender 5.1 retopology worker."
}

$Values = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $EnvironmentFile -Encoding UTF8) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $Values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
}
$Values["BLENDER_EXECUTABLE_PATH"] = $ResolvedBlenderPath

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

Write-Host "LI3D Blender configured: $ResolvedBlenderPath" -ForegroundColor Green
Write-Host "Version: $VersionLine" -ForegroundColor Green
