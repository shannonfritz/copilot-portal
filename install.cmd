@echo off
cd /d "%~dp0"

echo Checking for Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo Failed to install Node.js. Please install it from https://nodejs.org and re-run this script.
        pause
        exit /b 1
    )
    echo Node.js installed. You may need to open a new terminal window if 'node' is still not found.
)

echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo npm install failed. See errors above.
    pause
    exit /b 1
)

echo Applying compatibility patch...
node patch.mjs
if %errorlevel% neq 0 (
    echo Patch failed. See errors above.
    pause
    exit /b 1
)

echo.
echo =============================================
echo  Setup complete!
echo  Run start-and-launch.cmd to open the portal
echo =============================================
pause
