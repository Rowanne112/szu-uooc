@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "app\student\install-windows.ps1" -NodeOnly
if errorlevel 1 (
  echo 网络连接失败，请重新双击启动重试。
  pause
  exit /b 1
)
if not "%~1"=="" (
  "runtime\windows-x64\node.exe" "app\student\start.mjs" %*
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "app\student\launch-windows.ps1"
if errorlevel 1 pause
