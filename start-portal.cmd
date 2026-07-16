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
echo       These packages will be installed (from package.json):
node -e "var d=require('./package.json').dependencies||{};Object.keys(d).forEach(function(k){console.log('        - '+k+' '+d[k])})" 2>nul
echo.
echo       Installing npm packages (this can take a minute)...
:: We try up to three registries in order, showing a live heartbeat so the window
:: never looks frozen, and hiding npm's own (sometimes alarming) transient output
:: unless every registry fails:
::   1. Whatever this device is configured to use (the happy path).
::   2. Public npmjs - works for most users; blocked on some managed devices.
::   3. The Microsoft-approved feed (packagefeedproxy) - the corporate safety
::      net for devices where public npm is blocked (e.g. the "[TE] NPM URL
::      Block" / Tech Eviction policy on Microsoft-managed machines).
:: Corporate npm mirrors can also lag npmjs and 404 the newest @github/copilot,
:: which the chain likewise rides through. RC=1 means that attempt succeeded.
:: --fetch-retries=0: give each registry ONE shot (no retry + 10s backoff, which was
:: the main reason a dead/blocked registry took ~2min to give up). The 3-registry chain
:: below is our resilience layer, so per-attempt retries just slow down the fallback.
set "NPM_FLAGS=--no-fund --no-audit --fetch-retries=0 --fetch-timeout=60000"
set "WONREG="

call :npm_attempt "" "configured registry"
if "!RC!"=="1" goto :deps_ok
echo       Configured registry didn't work - trying public npmjs...
call :npm_attempt "https://registry.npmjs.org/" "public npmjs"
if "!RC!"=="1" ( set "WONREG=https://registry.npmjs.org/" & goto :deps_ok )
echo       Public npm unavailable - trying the Microsoft-approved feed...
call :npm_attempt "https://packagefeedproxy.microsoft.io/npm/" "Microsoft feed"
if "!RC!"=="1" ( set "WONREG=https://packagefeedproxy.microsoft.io/npm/" & goto :deps_ok )

:: All three failed - show the real npm error, then plain-English guidance.
echo.
echo  ERROR: Couldn't install npm packages from any registry.
if defined LASTLOG if exist "!LASTLOG!" (
    echo.
    echo  --- npm output ---
    type "!LASTLOG!"
    del "!LASTLOG!" >nul 2>&1
)
echo.
echo  If this is a corporate/managed device, public npm may be blocked and your
echo  approved package feed may differ. Point npm at it, then re-run this script:
echo.
echo      npm config set registry ^<your-approved-feed^>
echo.
echo  On Microsoft-managed devices the approved feed is:
echo      npm config set registry https://packagefeedproxy.microsoft.io/npm/
echo.
goto :done

:deps_ok
title Copilot Portal
if defined LASTLOG if exist "!LASTLOG!" del "!LASTLOG!" >nul 2>&1
:: If the MICROSOFT-APPROVED feed was the one that worked, pin it in a Portal-scoped
:: local .npmrc so future launches/updates go straight to the feed that's reachable on
:: this managed device. We deliberately DO NOT pin public npmjs: on managed devices it is
:: blocked, and a "win" there is almost always just npm's local cache - pinning it would
:: guarantee future failures and override the device's approved registry. If the configured
:: registry worked (WONREG empty) or public npmjs won, we leave npm untouched so the
:: launcher/updater re-resolves the newest allowed version each run. This .npmrc is written
:: in the install folder only and never touches the user's GLOBAL npm config.
if /I "!WONREG!"=="https://packagefeedproxy.microsoft.io/npm/" (
    >".npmrc" echo registry=!WONREG!
    echo       Pinned Portal to the Microsoft-approved feed !WONREG!
    echo       ^(saved to a local .npmrc here - your global npm settings are unchanged^)
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
goto :eof

:: ---------------------------------------------------------------------------
:: :npm_attempt "<registry-url-or-empty>" "<friendly label>"
:: Runs `npm install` in the background against the given registry (empty = the
:: device's configured registry), animating a "working..." heartbeat so the
:: window never looks frozen. npm's own output is captured to a temp log that is
:: deleted on success and preserved (in LASTLOG) on failure. On return:
::   RC       = 1 if the install succeeded, 0 if it failed
::   LASTLOG  = path to the captured npm output when RC=0 (else empty)
:: We branch on npm's exit code with &&/|| (not %errorlevel%) to avoid the
:: parent shell's delayed-expansion eating the child's errorlevel.
:: ---------------------------------------------------------------------------
:npm_attempt
setlocal enabledelayedexpansion
set "REGARG="
if not "%~1"=="" set "REGARG=--registry=%~1"
set "LOG=%TEMP%\portal-npm-%RANDOM%%RANDOM%.log"
set "OKF=%TEMP%\portal-npm-%RANDOM%%RANDOM%.ok"
if exist "!OKF!" del "!OKF!" >nul 2>&1
start "" /b cmd /c "call npm install %NPM_FLAGS% !REGARG! >""!LOG!"" 2>&1 && (>""!OKF!"" echo 1)|| (>""!OKF!"" echo 0)"
<nul set /p "=      working"
:na_spin
if exist "!OKF!" goto :na_done
<nul set /p "=."
>nul ping -n 2 -w 1000 127.0.0.1
goto :na_spin
:na_done
echo.
set /p RC=<"!OKF!"
del "!OKF!" >nul 2>&1
set "OUTLOG="
if not "!RC!"=="1" ( set "OUTLOG=!LOG!" ) else ( del "!LOG!" >nul 2>&1 )
endlocal & set "RC=%RC%" & set "LASTLOG=%OUTLOG%"
goto :eof
