param(
  [string]$InnoCompiler = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  [switch]$SkipBuild,
  [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DistRoot = Join-Path $Root "dist-local-component"
$StagingRoot = Join-Path $DistRoot "staging"
$InstallerScript = Join-Path $Root "installer\windows\LIclickTextureLocalComponent.iss"
$PackageVersion = (Get-Content -Raw -LiteralPath (Join-Path $Root "package.json") | ConvertFrom-Json).version
$NodeSource = Join-Path $Root "dist-installer\staging\node"
$IconPng = Join-Path $Root "assets\liclick-icon.png"
$IconIco = Join-Path $StagingRoot "assets\liclick-icon.ico"
$OutputInstaller = Join-Path $DistRoot "LIclick 3D Texture Local Component Setup.exe"
$WebDownloadDir = Join-Path $Root "apps\web\public\downloads\local-component"

function Invoke-Step {
  param([string]$Title, [scriptblock]$Script)
  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Script
}

function Assert-WorkspacePath {
  param([string]$Path)
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (!$resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the workspace: $resolvedPath"
  }
}

function Copy-StagingFile {
  param([string]$RelativePath)
  $source = Join-Path $Root $RelativePath
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required file was not found: $RelativePath"
  }
  $destination = Join-Path $StagingRoot $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Copy-StagingDirectory {
  param([string]$Source, [string]$Destination)
  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required directory was not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function New-IcoFromPng {
  param([string]$PngPath, [string]$IcoPath)
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

function Prepare-Staging {
  Assert-WorkspacePath $StagingRoot
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null

  Copy-StagingFile "scripts\windows-local-component.mjs"
  Copy-StagingFile "scripts\stop-local-component.mjs"
  Copy-StagingFile "scripts\start-local-component.vbs"
  Copy-StagingFile "assets\liclick-icon.png"

  $serverDistDestination = Join-Path $StagingRoot "apps\server\dist"
  & node (Join-Path $Root "scripts\copy-local-component-runtime.mjs") (Join-Path $Root "apps\server\dist") $serverDistDestination
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to collect the local component server modules."
  }
  @{
    name = "@liclick/local-texture-component"
    private = $true
    version = $PackageVersion
    type = "module"
    dependencies = @{ ws = "8.21.1" }
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $StagingRoot "apps\server\package.json") -Encoding UTF8

  $wsItem = Get-Item -LiteralPath (Join-Path $Root "apps\server\node_modules\ws") -Force
  $wsSource = if ($wsItem.LinkType -and $wsItem.Target) {
    [System.IO.Path]::GetFullPath([string]$wsItem.Target[0])
  } else {
    $wsItem.FullName
  }
  Copy-StagingDirectory $wsSource (Join-Path $StagingRoot "apps\server\node_modules\ws")
  $nodeDestination = Join-Path $StagingRoot "node"
  New-Item -ItemType Directory -Force -Path $nodeDestination | Out-Null
  Copy-Item -LiteralPath (Join-Path $NodeSource "node.exe") -Destination $nodeDestination -Force
  Copy-Item -LiteralPath (Join-Path $NodeSource "LICENSE") -Destination $nodeDestination -Force
  New-IcoFromPng -PngPath $IconPng -IcoPath $IconIco

  Get-ChildItem -LiteralPath $StagingRoot -Recurse -File |
    Where-Object { $_.Extension -in @(".ts", ".tsx", ".map") } |
    Remove-Item -Force

  $required = @(
    "apps\server\dist\localComponent.js",
    "apps\server\node_modules\ws\wrapper.mjs",
    "node\node.exe",
    "scripts\windows-local-component.mjs",
    "scripts\stop-local-component.mjs",
    "scripts\start-local-component.vbs",
    "assets\liclick-icon.ico"
  )
  foreach ($relativePath in $required) {
    if (!(Test-Path -LiteralPath (Join-Path $StagingRoot $relativePath))) {
      throw "Local component staging is missing: $relativePath"
    }
  }

  @{
    name = "LIclick 3D Texture Local Component"
    runtimeVersion = $PackageVersion
    workspacePort = 4617
    capabilities = @("texture-painting", "local-files", "project-storage", "dcc-bridge", "photoshop-bridge")
    excludes = @("electron-launcher", "web-homepage", "comfyui", "ai-models", "baking", "retopology", "auto-uv")
    preparedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $StagingRoot "local-component-manifest.json") -Encoding UTF8
}

Push-Location $Root
try {
  if (!$SkipBuild) {
    Invoke-Step "Build local component server" {
      & corepack pnpm --filter @liclick/server build
      if ($LASTEXITCODE -ne 0) {
        throw "Server build failed with exit code $LASTEXITCODE"
      }
    }
  }

  Invoke-Step "Prepare slim local component staging" {
    Prepare-Staging
  }

  if ($SkipCompile) {
    Write-Host "Staging ready: $StagingRoot" -ForegroundColor Green
    exit 0
  }

  Invoke-Step "Compile Windows installer" {
    if (!(Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
      throw "Inno Setup compiler not found: $InnoCompiler"
    }
    & $InnoCompiler "/DSourceRoot=$StagingRoot" "/DMyAppVersion=$PackageVersion" $InstallerScript
    if ($LASTEXITCODE -ne 0) {
      throw "Inno Setup failed with exit code $LASTEXITCODE"
    }
    if (!(Test-Path -LiteralPath $OutputInstaller -PathType Leaf)) {
      throw "Installer was not generated: $OutputInstaller"
    }
  }

  $installer = Get-Item -LiteralPath $OutputInstaller
  & node (Join-Path $Root "scripts\split-runtime-installer.mjs") $OutputInstaller $WebDownloadDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to prepare the web download parts."
  }
  Write-Host ""
  Write-Host "Installer: $($installer.FullName)" -ForegroundColor Green
  Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MB"
} finally {
  Pop-Location
}
