@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not exist "node_modules" (
  echo [ERROR] Dependencies not installed.
  echo Run install.bat first.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARN] .env not found. Please configure App ID / Secret.
)

if "%GUI_PORT%"=="" set GUI_PORT=3904
if "%GUI_PORT_STRICT%"=="" set GUI_PORT_STRICT=1
set "ELECTRON_RUN_AS_NODE="
set "NO_OPEN_BROWSER=1"

set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127.0.0.1:%GUI_PORT% .*LISTENING"') do (
  set "PORT_PID=%%P"
  goto :port_found
)
goto :port_ready

:port_found
echo [WARN] Port %GUI_PORT% is occupied by PID !PORT_PID!.
taskkill /PID !PORT_PID! /F >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Failed to stop process PID !PORT_PID! on port %GUI_PORT%.
  echo Please close that process manually, then run start-gui.bat again.
  pause
  exit /b 1
)
echo [INFO] Occupying process stopped.

:port_ready
echo [INFO] Starting local desktop app...
call npm run desktop
set EXIT_CODE=%ERRORLEVEL%
if not %EXIT_CODE%==0 (
  echo [ERROR] Desktop app stopped with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
