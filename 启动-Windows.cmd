@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "app\student\install-windows.ps1" (
  echo 请重新下载并完整解压安装包，再在解压后的文件夹里双击「启动-Windows.cmd」。
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "app\student\install-windows.ps1" -NodeOnly
if errorlevel 1 (
  echo 请先照上面的步骤操作，再双击「启动-Windows.cmd」。
  pause
  exit /b 1
)
if not "%~1"=="" (
  "runtime\windows-x64\node.exe" "app\student\start.mjs" %*
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "app\student\launch-windows.ps1"
if errorlevel 1 pause
