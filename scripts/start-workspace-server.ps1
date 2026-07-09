$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = if ($env:LICLICK_WORKSPACE_PORT) { [int]$env:LICLICK_WORKSPACE_PORT } else { 4517 }
$logDir = Join-Path $root "logs"
$logFile = Join-Path $logDir "workspace-server.log"
$errFile = Join-Path $logDir "workspace-server.err.log"

function Test-WorkspaceServer {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
    return [bool]$health.ok
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (Test-WorkspaceServer) {
  Write-Host "Liclick workspace server is already running at http://127.0.0.1:$port"
  exit 0
}

Push-Location $root
try {
  corepack pnpm --filter "@liclick/server" build
  $process = Start-Process -FilePath "node" `
    -ArgumentList "apps/server/dist/index.js" `
    -WorkingDirectory $root `
    -PassThru `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -WindowStyle Hidden

  for ($i = 0; $i -lt 30; $i++) {
    if (Test-WorkspaceServer) {
      Write-Host "Liclick workspace server started at http://127.0.0.1:$port"
      Write-Host "PID: $($process.Id)"
      Write-Host "Logs: $logFile"
      exit 0
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Workspace server did not become ready. Check $errFile"
} finally {
  Pop-Location
}
