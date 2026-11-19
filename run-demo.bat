@echo off
cd /d "%~dp0\app"
taskkill /F /IM SharkDeck.exe /T >nul 2>&1
rem The development build, in demo mode: one simulated device of each kind.
rem Demo mode then stays on for later development runs until it is switched
rem off in Settings > General.
set SHARKDECK_DEMO=1
call npm run dev
pause
