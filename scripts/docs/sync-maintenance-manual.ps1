param(
    [string]$PythonPath = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$sourcePath = Join-Path $repositoryRoot "docs\00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md"
$assetPath = Join-Path $repositoryRoot "docs\assets\LI3D_EDITOR_UI_BASELINE.png"
$docxBuilder = Join-Path $PSScriptRoot "build_maintenance_manual.py"
$pdfBuilder = Join-Path $PSScriptRoot "build_maintenance_pdf.py"

$sourceText = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
$versionMatch = [regex]::Match($sourceText, '(?m)^> [^\r\n]*?`([0-9]+\.[0-9]+\.[0-9]+)`')
if (-not $versionMatch.Success) {
    throw "Cannot find the document version in $sourcePath"
}

$documentVersion = $versionMatch.Groups[1].Value
$docxPath = Join-Path $repositoryRoot "output\docx\LI3D_System_Maintenance_Manual_v$documentVersion.docx"
$pdfPath = Join-Path $repositoryRoot "output\pdf\LI3D_System_Maintenance_Manual_v$documentVersion.pdf"
$inputs = @($sourcePath, $docxBuilder, $pdfBuilder)
if (Test-Path -LiteralPath $assetPath) {
    $inputs += $assetPath
}
$latestInputWrite = ($inputs | Get-Item | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
$outputsCurrent =
    (Test-Path -LiteralPath $docxPath) -and
    (Test-Path -LiteralPath $pdfPath) -and
    ((Get-Item -LiteralPath $docxPath).LastWriteTimeUtc -ge $latestInputWrite) -and
    ((Get-Item -LiteralPath $pdfPath).LastWriteTimeUtc -ge $latestInputWrite)

if ($outputsCurrent -and -not $Force) {
    Write-Output "Maintenance manual v$documentVersion is already current; generation skipped."
    exit 0
}

if (-not $PythonPath) {
    $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $bundledPython) {
        $PythonPath = $bundledPython
    }
    else {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCommand) {
            $PythonPath = $pythonCommand.Source
        }
    }
}

if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath)) {
    throw "Python was not found. Pass -PythonPath with an environment containing python-docx and reportlab."
}

& $PythonPath -c "import docx, reportlab"
if ($LASTEXITCODE -ne 0) {
    throw "The selected Python environment needs python-docx and reportlab."
}

& $PythonPath $docxBuilder
if ($LASTEXITCODE -ne 0) {
    throw "DOCX generation failed."
}

& $PythonPath $pdfBuilder
if ($LASTEXITCODE -ne 0) {
    throw "PDF generation failed."
}

Write-Output "Updated maintenance manual v${documentVersion}:"
Write-Output "  DOCX: $docxPath"
Write-Output "  PDF:  $pdfPath"
