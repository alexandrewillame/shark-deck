@echo off
cd /d "%~dp0\app"
rem Stop only THIS project's dev Electron, if dev.bat left one running (it can
rem hide in the tray). It holds the same single-instance lock as the packaged
rem app, so the launch below would otherwise just wake it instead of starting
rem the real build. Matched by path so other Electron apps are left alone.
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($PWD.Path + '\node_modules\electron\*') } | Stop-Process -Force" >nul 2>&1
call npm run pack
"%~dp0dist\app\SharkDeck.exe"
pause
