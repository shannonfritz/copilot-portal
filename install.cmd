@echo off
cd /d "%~dp0"

echo.
echo ========================================
echo   Copilot Portal - Setup
echo ========================================
echo.

:: ---- Step 1: Node.js ----
echo [1/4] Checking for Node.js...
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

:: ---- Step 2: PowerShell 7 ----
echo.
echo [2/4] Checking for PowerShell 7...
pwsh --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo       PowerShell 7 is not installed.
    echo       Copilot CLI uses PowerShell 7 for running commands.
    echo       Without it, many tools will not work correctly.
    echo.
    set /p INSTALL_PWSH="       Install PowerShell 7 now? (Y/n): "
    if /i "%INSTALL_PWSH%"=="n" (
        echo.
        echo  WARNING: Skipping PowerShell 7. Some features will not work.
        echo  You can install it later with: winget install Microsoft.PowerShell
    ) else (
        echo       Installing PowerShell 7 via winget...
        winget install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements
        if %errorlevel% neq 0 (
            echo.
            echo  WARNING: Could not install PowerShell 7 automatically.
            echo  Install manually: winget install Microsoft.PowerShell
            echo  or download from https://aka.ms/powershell-release
        ) else (
            echo       PowerShell 7 installed successfully.
        )
    )
) else (
    for /f "tokens=*" %%v in ('pwsh --version') do echo       Found %%v
)

:: ---- Step 3: npm install + patch ----
echo.
echo [3/4] Installing dependencies...
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

:: ---- Step 4: GitHub authentication ----
echo.
echo [4/4] Checking GitHub authentication...
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
