@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [ERROR] Dependencies not installed.
  echo Run install.bat first.
  pause
  exit /b 1
)

echo [INFO] Building Electron portable exe...
call npm run build:exe
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [DONE] Portable EXE created under dist\
pause
exit /b 0
