param(
  [string]$InnoCompiler = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  [string]$NodeVersion = "22.13.1",
  [string]$NodeZipPath = "",
  [switch]$BundlePortableNode,
  [switch]$SkipPortableNode,
  [switch]$SkipPrepare,
  [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DistRoot = Join-Path $Root "dist-installer"
$StagingRoot = Join-Path $DistRoot "staging"
$InstallerScript = Join-Path $Root "installer\windows\Liclick3DTexture.iss"
$IconPng = Join-Path $Root "assets\liclick-icon.png"
$IconIco = Join-Path $StagingRoot "assets\liclick-icon.ico"
$PreparedMarker = Join-Path $StagingRoot ".liclick-prepared-runtime.json"
$NodeDir = Join-Path $StagingRoot "node"
$ElectronSourceDir = Join-Path $Root "node_modules\electron\dist"
$ElectronDir = Join-Path $StagingRoot "electron"
$ElectronExe = Join-Path $ElectronDir "Liclick 3D Texture.exe"
$PackageVersion = (Get-Content -Raw -LiteralPath (Join-Path $Root "package.json") | ConvertFrom-Json).version

function Invoke-Step {
  param(
    [string]$Title,
    [scriptblock]$Script
  )
  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Script
}

function Invoke-LoggedCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [hashtable]$Environment = @{}
  )
  $previous = @{}
  foreach ($key in $Environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function New-IcoFromPng {
  param(
    [string]$PngPath,
    [string]$IcoPath
  )
  Add-Type -AssemblyName System.Drawing
  $source = [System.Drawing.Image]::FromFile($PngPath)
  try {
    $bitmap = New-Object System.Drawing.Bitmap 256, 256
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.DrawImage($source, 0, 0, 256, 256)
    } finally {
      $graphics.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $pngBytes = $stream.ToArray()
    } finally {
      $stream.Dispose()
      $bitmap.Dispose()
    }
  } finally {
    $source.Dispose()
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $IcoPath) | Out-Null
  $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create))
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]1)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$pngBytes.Length)
    $writer.Write([UInt32]22)
    $writer.Write($pngBytes)
  } finally {
    $writer.Close()
  }
}

function Copy-RepoToStaging {
  New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
  if (Test-Path $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null

  $xd = @(
    ".git",
    ".pnpm-store",
    ".turbo",
    ".vite",
    ".codex-tmp",
    "dist-installer",
    "logs",
    "secrets",
    "workspace",
    "workspace-auth-smoke",
    "workspace-auth-smoke-feishu"
  )
  $xdNames = @("node_modules")
  $xf = @("*.log", "*.tsbuildinfo", "*.local", ".env", "*.atlas-ai-gateway-oauth.json")
  $args = @($Root, $StagingRoot, "/MIR", "/MT:16", "/R:2", "/W:1", "/NFL", "/NDL", "/NP")
  foreach ($dir in $xd) { $args += @("/XD", (Join-Path $Root $dir)) }
  foreach ($dir in $xdNames) { $args += @("/XD", $dir) }
  foreach ($file in $xf) { $args += @("/XF", $file) }
  & robocopy @args
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
  }
}

function Install-PortableNode {
  if (Test-Path (Join-Path $NodeDir "node.exe")) {
    return
  }
  if ($SkipPortableNode -and !$BundlePortableNode -and !$NodeZipPath) {
    Write-Host "Portable Node bundling is disabled. The desktop launcher will download Node on first run if needed."
    return
  }
  if ($NodeZipPath) {
    $zipPath = (Resolve-Path $NodeZipPath).Path
  } else {
    $zipPath = Join-Path $DistRoot "node-v$NodeVersion-win-x64.zip"
    if (!(Test-Path $zipPath)) {
      $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
      Write-Host "Downloading portable Node from $url"
      Invoke-WebRequest -Uri $url -OutFile $zipPath
    }
  }

  $extractRoot = Join-Path $DistRoot "node-extract"
  if (Test-Path $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  $inner = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
  if (!$inner) {
    throw "Could not find extracted Node directory."
  }
  if (Test-Path $NodeDir) {
    Remove-Item -LiteralPath $NodeDir -Recurse -Force
  }
  Move-Item -Path $inner.FullName -Destination $NodeDir
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

function Copy-ElectronRuntime {
  if (!(Test-Path (Join-Path $ElectronSourceDir "electron.exe"))) {
    throw "Electron runtime was not found at $ElectronSourceDir. Run corepack pnpm install before packaging."
  }
  if (Test-Path $ElectronDir) {
    Remove-Item -LiteralPath $ElectronDir -Recurse -Force
  }
  Copy-Item -LiteralPath $ElectronSourceDir -Destination $ElectronDir -Recurse -Force
  Move-Item -LiteralPath (Join-Path $ElectronDir "electron.exe") -Destination $ElectronExe -Force
}

Push-Location $Root
try {
  if (!$SkipPrepare) {
    Invoke-Step "Install dependencies" {
      try {
        Invoke-LoggedCommand "corepack" @("enable")
      } catch {
        Write-Warning "corepack enable failed; continuing with corepack pnpm. $($_.Exception.Message)"
      }
      Invoke-LoggedCommand "corepack" @("pnpm", "install", "--frozen-lockfile")
    }
    Invoke-Step "Generate Prisma client and build apps" {
      $buildEnv = @{
        "LICLICK_WORKSPACE_PORT" = "4617"
        "LICLICK_WEB_PORT" = "5673"
        "LICLICK_PUBLIC_WORKSPACE_URL" = "http://127.0.0.1:4617"
        "VITE_LICLICK_WORKSPACE_API" = "http://127.0.0.1:4617"
        "LICLICK_FRONTEND_URL" = "http://127.0.0.1:5673"
      }
      Invoke-LoggedCommand "corepack" @("pnpm", "--filter", "@liclick/server", "db:generate") $buildEnv
      Invoke-LoggedCommand "corepack" @("pnpm", "--filter", "@liclick/server", "build") $buildEnv
      Invoke-LoggedCommand "corepack" @("pnpm", "--filter", "@liclick/web", "build") $buildEnv
    }
  }

  Invoke-Step "Prepare installer staging directory" {
    Copy-RepoToStaging
    New-IcoFromPng -PngPath $IconPng -IcoPath $IconIco
    Copy-ElectronRuntime
    Install-PortableNode
    @{
      preparedAt = (Get-Date).ToString("o")
      packageVersion = $PackageVersion
      workspacePort = 4617
      webPort = 5673
      includesNodeModules = (Test-Path (Join-Path $StagingRoot "node_modules"))
      includesPortableNode = (Test-Path (Join-Path $NodeDir "node.exe"))
      includesElectronShell = (Test-Path $ElectronExe)
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $PreparedMarker -Encoding UTF8
  }

  if ($SkipCompile) {
    Write-Host "Skipping Inno Setup compile. Staging is ready: $StagingRoot"
    exit 0
  }

  Invoke-Step "Compile Inno Setup installer" {
    if (!(Test-Path $InnoCompiler)) {
      throw "Inno Setup compiler not found: $InnoCompiler"
    }
    if (!(Test-Path $InstallerScript)) {
      throw "Installer script not found: $InstallerScript"
    }
    & $InnoCompiler "/DSourceRoot=$StagingRoot" "/DMyAppVersion=$PackageVersion" $InstallerScript
    if ($LASTEXITCODE -ne 0) {
      throw "Inno Setup failed with exit code $LASTEXITCODE"
    }
  }

  Write-Host ""
  Write-Host "Installer output: $(Join-Path $DistRoot 'Liclick 3D Texture Setup.exe')" -ForegroundColor Green
} finally {
  Pop-Location
}
