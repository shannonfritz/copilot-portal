@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Copilot Portal

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
    title Copilot Portal
    if !errorlevel! neq 0 (
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
for /f "tokens=*" %%v in ('node --version') do echo       Found Node.js %%v

:: ---- Step 2: Dependencies ----
echo.
echo [2/3] Checking dependencies...
:: (Re)install only when node_modules is missing OR the installed code version has
:: changed since deps were last installed. An extract-over update replaces the app
:: files (including package.json) but leaves the OLD node_modules in place; without
:: this check a dependency bump would be silently skipped and could break the new
:: build. We stamp node_modules\.portal-deps-version after each successful install.
set "PKG_VER="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set "PKG_VER=%%v"
set "DEP_VER="
if exist "node_modules\.portal-deps-version" set /p DEP_VER=<"node_modules\.portal-deps-version"
if not exist node_modules goto :deps_install
if not defined PKG_VER (
    echo       Dependencies already installed.
    goto :deps_done
)
if not "%DEP_VER%"=="%PKG_VER%" (
    echo       Update detected: dependencies built for "%DEP_VER%", now "%PKG_VER%" - refreshing...
    goto :deps_install
)
echo       Dependencies already installed (%PKG_VER%).
goto :deps_done

:deps_install
echo       Installing npm packages...
:: First attempt against the configured registry, quietly - some corporate npm
:: mirrors (e.g. packagefeedproxy) lag npmjs and 404 the newest @github/copilot,
:: and we don't want that transient miss to dump an alarming error block. If it
:: fails we retry against public npmjs with visible progress.
call npm install --no-fund --no-audit >nul 2>&1
title Copilot Portal
if %errorlevel% neq 0 (
    echo       Configured registry is missing a package - falling back to public npmjs...
    call npm install --no-fund --no-audit --registry=https://registry.npmjs.org/
    title Copilot Portal
    if !errorlevel! neq 0 (
        echo.
        echo  ERROR: npm install failed. See errors above.
        goto :done
    )
)
:: Record the version deps were installed for so future updates are detected.
if defined PKG_VER (>"node_modules\.portal-deps-version" echo %PKG_VER%)
echo       Done.
:deps_done

:: ---- Step 3: PowerShell 7 ----
echo.
echo [3/3] Checking for PowerShell 7...
pwsh --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('pwsh --version') do echo       Found %%v
    goto :pwsh_done
)
echo       PowerShell 7 is not installed.
echo       Copilot CLI uses it for running commands - some tools won't work without it.
echo.
set /p INSTALL_PWSH="       Install PowerShell 7 now? (Y/n): "
if /i "!INSTALL_PWSH!"=="n" goto :pwsh_done
winget install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements
title Copilot Portal
if %errorlevel% neq 0 (
    echo.
    echo       Could not install automatically. You can install later with:
    echo         winget install Microsoft.PowerShell
) else (
    echo       PowerShell 7 installed successfully.
)
:pwsh_done

:: GitHub sign-in is handled by the Portal itself: on first load with no signed-in
:: user, the web UI shows a sign-in screen (device-code flow surfaced in the browser).
:: We intentionally do NOT run `copilot login` here - that would force the console
:: device-code experience the Portal's in-app flow was built to replace.

:: Check if port is already in use
netstat -ano 2>nul | findstr ":3847.*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo  Port 3847 is already in use - the portal may already be running.
    echo  Close the other instance first, or use: npm start -- --port 3849
    goto :done
)

:: ---- Start the portal ----
echo.
echo ========================================
echo   Starting Copilot Portal...
echo ========================================
echo.
call npm start -- %*
title Copilot Portal

:done
echo.
pause
