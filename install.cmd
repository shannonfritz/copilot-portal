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

echo Checking for Copilot CLI...
where copilot >nul 2>&1
if %errorlevel% neq 0 (
    echo Copilot CLI not found. Installing via winget...
    winget install GitHub.Copilot --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo Failed to install Copilot CLI. Please install it from https://github.com/github/copilot-cli and re-run this script.
        pause
        exit /b 1
    )
    echo Copilot CLI installed. You may need to open a new terminal if 'copilot' is still not found.
)

echo Checking GitHub authentication...
copilot auth status >nul 2>&1
if %errorlevel% neq 0 (
    echo Not signed in to GitHub. Starting login...
    echo A browser window will open for you to sign in with your GitHub account.
    copilot auth login
    if %errorlevel% neq 0 (
        echo GitHub login failed. Please try again.
        pause
        exit /b 1
    )
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
