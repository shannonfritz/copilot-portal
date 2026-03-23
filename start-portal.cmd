@echo off
setlocal
cd /d "%~dp0"

:: ---- Quick checks (skip if already set up) ----

:: Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: Could not install Node.js automatically.
        echo  Please install Node.js v22+ from https://nodejs.org
        echo  then re-run this script.
        goto :done
    )
    echo.
    echo  Node.js installed. Please close this window, open a
    echo  new terminal, and re-run start-portal.cmd.
    goto :done
)

:: Dependencies (only if node_modules is missing)
if not exist node_modules (
    echo.
    echo  First-time setup — installing dependencies...
    echo.
    call npm install --no-fund --no-audit
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: npm install failed. See errors above.
        goto :done
    )
    if exist patch.mjs (
        echo  Applying compatibility patch...
        node patch.mjs
    )
    echo.
)

:: PowerShell 7 (check once, don't block startup)
pwsh --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  NOTE: PowerShell 7 is not installed.
    echo  Copilot CLI uses it for running commands — some tools won't work without it.
    echo.
    set /p INSTALL_PWSH="  Install PowerShell 7 now? (Y/n): "
    if /i not "%INSTALL_PWSH%"=="n" (
        winget install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements
        if %errorlevel% neq 0 (
            echo.
            echo  Could not install automatically. You can install later with:
            echo    winget install Microsoft.PowerShell
        )
    )
    echo.
)

:: GitHub authentication
node -e "try{const c=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.copilot','config.json'),'utf8'));process.exit(c.logged_in_users&&c.logged_in_users.length?0:1)}catch{process.exit(1)}" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Not signed in to GitHub. A browser window will open
    echo  so you can sign in with your GitHub account.
    echo.
    call node_modules\.bin\copilot.cmd login
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: GitHub login failed. Please try again.
        goto :done
    )
    echo.
)

:: Check if port is already in use
netstat -ano 2>nul | findstr ":3847.*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo  Port 3847 is already in use - the portal may already be running.
    echo  Close the other instance first, or use: npm start -- --port 3848
    goto :done
)

:: ---- Start the portal ----
echo.
echo  Starting Copilot Portal...
echo.
call npm start

:done
echo.
pause
