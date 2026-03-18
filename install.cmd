@echo off
cd /d "%~dp0"

echo.
echo ========================================
echo   Copilot Portal - Setup
echo ========================================
echo.

:: ---- Step 1: Node.js ----
echo [1/3] Checking for Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo       Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: Could not install Node.js automatically.
        echo  Please install Node.js v22+ from https://nodejs.org
        echo  then re-run this script.
        pause
        exit /b 1
    )
    echo.
    echo  Node.js installed. Please close this window, open a
    echo  new terminal, and re-run install.cmd so the 'node'
    echo  command is available.
    pause
    exit /b 0
)
for /f "tokens=*" %%v in ('node --version') do echo       Found Node.js %%v

:: ---- Step 2: npm install + patch ----
echo.
echo [2/3] Installing dependencies...
call npm install --no-fund --no-audit
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: npm install failed. See errors above.
    pause
    exit /b 1
)
echo       Applying compatibility patch...
node patch.mjs
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Patch failed. See errors above.
    pause
    exit /b 1
)

:: ---- Step 3: GitHub authentication ----
echo.
echo [3/3] Checking GitHub authentication...
:: The SDK bundles the Copilot CLI binary. Use it to check/run login.
:: Auth state is stored in ~/.copilot/config.json (logged_in_users array).
node -e "try{const c=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.copilot','config.json'),'utf8'));process.exit(c.logged_in_users&&c.logged_in_users.length?0:1)}catch{process.exit(1)}" >nul 2>&1
if %errorlevel% neq 0 (
    echo       Not signed in. A browser window will open so you
    echo       can sign in with your GitHub account.
    echo.
    call node_modules\.bin\copilot.cmd login
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: GitHub login failed. Please try again.
        pause
        exit /b 1
    )
) else (
    echo       Already authenticated.
)

echo.
echo ========================================
echo   Setup complete!
echo.
echo   To start the portal, run:
echo     start-and-launch.cmd
echo ========================================
pause
