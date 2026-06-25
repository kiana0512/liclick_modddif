@echo off
setlocal

set "APP_ROOT=%~dp0.."
for %%I in ("%APP_ROOT%") do set "APP_ROOT=%%~fI"

if /I not "%~1"=="--elevated" (
  net session >nul 2>nul
  if not "%ERRORLEVEL%"=="0" (
    echo.
    echo Liclick 3D Texture needs administrator permission to run the local desktop launcher.
    echo Please approve the Windows permission prompt.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/k ""%~f0"" --elevated' -WorkingDirectory '%APP_ROOT%' -Verb RunAs"
    exit /b 0
  )
)

if not defined LICLICK_WORKSPACE_PORT set "LICLICK_WORKSPACE_PORT=4617"
if not defined LICLICK_WEB_PORT set "LICLICK_WEB_PORT=5673"
if not defined LICLICK_PUBLIC_WORKSPACE_URL set "LICLICK_PUBLIC_WORKSPACE_URL=http://127.0.0.1:%LICLICK_WORKSPACE_PORT%"
if not defined VITE_LICLICK_WORKSPACE_API set "VITE_LICLICK_WORKSPACE_API=http://127.0.0.1:%LICLICK_WORKSPACE_PORT%"
if not defined LICLICK_FRONTEND_URL set "LICLICK_FRONTEND_URL=http://127.0.0.1:%LICLICK_WEB_PORT%"
if not defined LICLICK_WORKSPACE_DIR set "LICLICK_WORKSPACE_DIR=%LocalAppData%\Liclick 3D Texture\workspace"
if not defined DATABASE_URL set "DATABASE_URL=file:%LocalAppData:\=/%/Liclick 3D Texture/workspace/liclick.db"

set "NODE_EXE=%APP_ROOT%\node\node.exe"
if exist "%NODE_EXE%" goto run_launcher

where node >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  set "NODE_EXE=node"
  goto run_launcher
)

echo.
echo Node.js was not found. Liclick will download a local Node.js runtime now.
echo This only happens on the first launch and may take a few minutes.
echo.
powershell -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\windows-node-bootstrap.ps1"
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo Failed to install Node.js. Please check the error above.
  pause
  exit /b 1
)
set "NODE_EXE=%LocalAppData%\Liclick 3D Texture\node\node.exe"

:run_launcher

echo.
echo Liclick 3D Texture local launcher
echo Install root: %APP_ROOT%
echo.

"%NODE_EXE%" "%APP_ROOT%\scripts\windows-desktop-launcher.mjs"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Liclick 3D Texture has stopped. Exit code: %EXIT_CODE%
echo You can close this window now.
pause
exit /b %EXIT_CODE%
