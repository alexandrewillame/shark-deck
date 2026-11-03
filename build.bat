@echo off
rem Windows build. On macOS/Linux, run build.sh instead.
setlocal enabledelayedexpansion

echo Building SharkDeck...
echo.

cd /d "%~dp0app"
if errorlevel 1 (
    echo Error: cannot find the "app" folder next to this script.
    pause
    exit /b 1
)

echo Installing dependencies...
call npm install
if errorlevel 1 (
    echo.
    echo Error: npm install failed
    pause
    exit /b 1
)

echo.
echo Building project...
call npm run dist
if errorlevel 1 (
    echo.
    echo Error: Build failed
    echo.
    echo Check the electron-builder error above - it says what went wrong.
    echo.
    echo Only if it failed extracting "winCodeSign" ^(a symbolic-link / privilege
    echo error^), try any one of:
    echo   - run  npm run prep:wincodesign  from the app folder, then retry this script
    echo   - enable Developer Mode: Settings ^> System ^> For developers
    echo   - run this script from an elevated ^(Administrator^) terminal
    pause
    exit /b 1
)

echo.
echo Build complete! Output is in ..\dist\
pause
