@echo off
cd /d "%~dp0\app"
taskkill /F /IM SharkDeck.exe /T >nul 2>&1
call npm run dev
pause
