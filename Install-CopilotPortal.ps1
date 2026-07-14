<#
.SYNOPSIS
    One-line graphical installer for Copilot Portal.

.DESCRIPTION
    Bootstraps Copilot Portal on a clean Windows machine with no prerequisites
    beyond the Windows PowerShell 5.1 that ships with every Windows install.

    Designed to be run straight from the web:

        powershell -ExecutionPolicy Bypass -c "irm https://aka.ms/copilot-portal | iex"

    It presents a small WPF window (single-file, no external assemblies beyond
    the in-box .NET Framework WPF/WinForms) that lets you pick an install folder
    and then, in a background runspace so the UI never freezes:

        1. Ensures Node.js is present and >= the required floor (winget, with a
           nodejs.org MSI fallback when winget is unavailable), refreshing PATH
           in-session so no terminal restart is needed.
        2. Resolves the latest Copilot Portal release from GitHub and downloads
           the release zip.
        3. Extracts it to the chosen folder.
        4. Optionally creates Start Menu / Desktop shortcuts.
        5. Offers an "Open Portal" button that runs start-portal.cmd.

    The installer intentionally stops at acquisition + Node + shortcuts. It does
    NOT run `npm install` or install PowerShell 7 itself: start-portal.cmd already
    does both on first launch, and GitHub sign-in happens in the Portal's web UI.
    Keeping bootstrap in one place (start-portal.cmd) avoids duplicated, drift-prone
    logic. Ensuring Node here is the one exception - it spares the user start-portal's
    "Node installed, now close this window and re-run" hop.

    Prerequisite policy: the installer checks PRESENCE + a MINIMUM FLOOR, not
    "latest". Point-release currency of Node/PowerShell is intentionally left to
    the OS. Toolchain currency (portal, @github/copilot, copilot-sdk) is handled
    by the portal's own in-app updater.

.PARAMETER InstallPath
    Target folder. Defaults to C:\copilot-portal. In GUI mode this pre-fills the
    location box; the user can change it.

.PARAMETER Repo
    GitHub owner/repo to install from. Defaults to shannonfritz/copilot-portal.

.PARAMETER Silent
    Run headless (no window) with console logging. Useful for scripted installs.

.PARAMETER NoStartMenu
    Skip the Start Menu shortcut (GUI: unchecks the box).

.PARAMETER NoDesktop
    Skip the Desktop shortcut (GUI: unchecks the box).

.PARAMETER Launch
    In -Silent mode, launch the portal when the install completes.

.NOTES
    Windows-only (v1). Single-file by design so it can be curl-piped.
    Inspired by shannonfritz/WinCPC-Tenant-Setup and shannonfritz/CloudPC-Replace.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $InstallPath = 'C:\copilot-portal',
    [string] $Repo        = 'shannonfritz/copilot-portal',
    [switch] $Silent,
    [switch] $NoStartMenu,
    [switch] $NoDesktop,
    [switch] $Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# TLS 1.2 for GitHub/nodejs downloads (PS 5.1 may otherwise negotiate TLS 1.0).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# Minimum host-prereq floors (presence + floor, NOT latest - see .DESCRIPTION).
$script:NODE_MIN = [version]'22.5.0'

# ---------------------------------------------------------------------------
# Shared install engine.
#
# Defined as ONE scriptblock so the exact same code path runs whether we invoke
# it synchronously (-Silent) or on a background runspace (GUI). All helper
# functions live INSIDE the block so they exist in whichever runspace runs it.
#
# Progress is reported through a synchronized hashtable ($sync):
#   $sync.Log     - synchronized Queue of "[tag] message" lines to surface
#   $sync.Percent - 0..100 overall progress
#   $sync.Status  - short status string for the header
#   $sync.Console - $true to also Write-Host (silent mode)
#   $sync.Done    - set $true when finished (success or failure)
#   $sync.Error   - error message string on failure, else $null
#   $sync.InstallPath - final install path (echoed back for the launcher)
# ---------------------------------------------------------------------------
$Engine = {
    param(
        [hashtable] $sync,
        [string]    $InstallPath,
        [string]    $Repo,
        [version]   $NodeMin,
        [bool]      $MakeStartMenu,
        [bool]      $MakeDesktop
    )

    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

    function Emit {
        param([string]$Message, [string]$Tag = 'INFO')
        $line = "[$Tag] $Message"
        try { $sync.Log.Enqueue($line) } catch { }
        if ($sync.Console) {
            $color = switch ($Tag) {
                'OK'   { 'Green' }
                'WARN' { 'Yellow' }
                'FAIL' { 'Red' }
                'STEP' { 'Cyan' }
                default { 'Gray' }
            }
            Write-Host $line -ForegroundColor $color
        }
    }
    function Progress { param([int]$Percent, [string]$Status) $sync.Percent = $Percent; if ($Status) { $sync.Status = $Status } }

    # Re-read PATH from the registry (Machine + User) into this process, so tools
    # winget/MSI just installed become callable WITHOUT restarting the terminal.
    function Update-SessionPath {
        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = @($machine, $user | Where-Object { $_ }) -join ';'
    }

    function Test-Cmd { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

    # Extract a zip using the .NET API rather than Expand-Archive: the background
    # runspace does not auto-load the Microsoft.PowerShell.Archive module, and this
    # is dependency-free and supports overwrite.
    function Expand-Zip {
        param([string]$ZipPath, [string]$Dest)
        Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
        if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
        $full = [System.IO.Path]::GetFullPath((Resolve-Path $Dest).Path)
        $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
        try {
            foreach ($entry in $zipArchive.Entries) {
                $rel = $entry.FullName -replace '/', '\'
                $target = [System.IO.Path]::GetFullPath((Join-Path $full $rel))
                if (-not $target.StartsWith($full, [StringComparison]::OrdinalIgnoreCase)) { continue } # path-traversal guard
                if ([string]::IsNullOrEmpty($entry.Name)) {
                    New-Item -ItemType Directory -Path $target -Force | Out-Null
                    continue
                }
                $dir = Split-Path $target -Parent
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        } finally { $zipArchive.Dispose() }
    }

    function Get-NodeVersion {
        if (-not (Test-Cmd 'node')) { return $null }
        try {
            $raw = (& node -v) 2>$null   # e.g. "v22.9.0"
            if ($raw -match 'v?(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
        } catch { }
        return $null
    }

    # Run an external process, streaming stdout/stderr lines into the log live.
    # Returns the exit code. Used for winget / npm / msiexec so the GUI shows
    # progress instead of hanging on a single blocking call.
    function Invoke-Logged {
        param([string]$FilePath, [string]$Arguments, [string]$WorkDir, [string]$Tag = 'proc')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = $FilePath
        $psi.Arguments              = $Arguments
        $psi.UseShellExecute        = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.CreateNoWindow         = $true
        if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $psi
        $sink = {
            if ($EventArgs.Data) {
                $t = $Event.MessageData
                try { $sync.Log.Enqueue("[$t] " + $EventArgs.Data) } catch { }
                if ($sync.Console) { Write-Host ("[$t] " + $EventArgs.Data) -ForegroundColor DarkGray }
            }
        }
        $so = Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action $sink -MessageData $Tag
        $se = Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived  -Action $sink -MessageData $Tag
        try {
            [void]$p.Start()
            $p.BeginOutputReadLine()
            $p.BeginErrorReadLine()
            $p.WaitForExit()
            return $p.ExitCode
        } finally {
            Unregister-Event -SourceIdentifier $so.Name -ErrorAction SilentlyContinue
            Unregister-Event -SourceIdentifier $se.Name -ErrorAction SilentlyContinue
            $p.Dispose()
        }
    }

    function Install-NodeViaWinget {
        Emit 'Installing Node.js LTS via winget...' 'STEP'
        $code = Invoke-Logged -FilePath 'winget' -Arguments 'install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent' -Tag 'winget'
        Update-SessionPath
        return $code
    }

    function Install-NodeViaMsi {
        Emit 'winget not available - downloading the Node.js LTS MSI directly...' 'STEP'
        $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'copilot-portal-installer' }
        $lts   = $index | Where-Object { $_.lts } | Select-Object -First 1
        if (-not $lts) { throw 'Could not determine the latest Node.js LTS from nodejs.org.' }
        $ver   = $lts.version   # e.g. "v22.11.0"
        $arch  = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
        $url   = "https://nodejs.org/dist/$ver/node-$ver-$arch.msi"
        $msi   = Join-Path $env:TEMP "node-$ver-$arch.msi"
        Emit "Downloading $url" 'proc'
        Invoke-WebRequest $url -OutFile $msi -UseBasicParsing
        Emit 'Running the Node.js installer (may prompt for elevation)...' 'proc'
        $code = Invoke-Logged -FilePath 'msiexec.exe' -Arguments "/i `"$msi`" /qn /norestart" -Tag 'msi'
        Update-SessionPath
        Remove-Item $msi -ErrorAction SilentlyContinue
        return $code
    }

    function Ensure-Node {
        $v = Get-NodeVersion
        if ($v -and $v -ge $NodeMin) { Emit "Node.js $v already present (>= $NodeMin)." 'OK'; return }
        if ($v) { Emit "Node.js $v is below the required $NodeMin - upgrading." 'WARN' }
        else    { Emit 'Node.js not found - installing.' 'INFO' }

        if (Test-Cmd 'winget') { [void](Install-NodeViaWinget) }
        else                   { [void](Install-NodeViaMsi) }

        $v = Get-NodeVersion
        if (-not $v)            { throw 'Node.js is still not detected after install. Please install Node.js v22+ from https://nodejs.org and re-run.' }
        if ($v -lt $NodeMin)    { throw "Node.js $v is still below the required $NodeMin." }
        Emit "Node.js $v ready." 'OK'
    }

    function Get-LatestReleaseZipUrl {
        $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'copilot-portal-installer' }
        $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
        if (-not $asset) { throw "No .zip asset found on the latest $Repo release ($($rel.tag_name))." }
        return [pscustomobject]@{ Tag = $rel.tag_name; Name = $asset.name; Url = $asset.browser_download_url }
    }

    function New-PortalShortcut {
        param([string]$LinkPath, [string]$Target, [string]$WorkDir)
        $ws  = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($LinkPath)
        $lnk.TargetPath       = $Target
        $lnk.WorkingDirectory = $WorkDir
        $lnk.Description       = 'Copilot Portal'
        # Ship a proper brand icon so the shortcut isn't the generic batch-file icon.
        # The .ico rides along in the release zip under dist\webui\.
        $ico = Join-Path $WorkDir 'dist\webui\favicon.ico'
        if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
        $lnk.Save()
    }

    # ---- Orchestration --------------------------------------------------
    $sync.InstallPath = $InstallPath
    Emit "Installing Copilot Portal to: $InstallPath" 'STEP'
    Progress 5 'Checking Node.js...'
    Ensure-Node

    Progress 30 'Finding the latest release...'
    $rel = Get-LatestReleaseZipUrl
    Emit "Latest release: $($rel.Tag) ($($rel.Name))" 'OK'

    Progress 40 'Downloading...'
    if (-not (Test-Path $InstallPath)) { New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null }
    $zip = Join-Path $env:TEMP $rel.Name
    Emit "Downloading $($rel.Url)" 'proc'
    Invoke-WebRequest $rel.Url -OutFile $zip -UseBasicParsing
    Emit 'Download complete.' 'OK'

    Progress 55 'Extracting...'
    Expand-Zip -ZipPath $zip -Dest $InstallPath
    Remove-Item $zip -ErrorAction SilentlyContinue
    Emit "Extracted to $InstallPath." 'OK'
    if (-not (Test-Path (Join-Path $InstallPath 'start-portal.cmd'))) {
        throw "Extraction did not produce start-portal.cmd in $InstallPath - the release layout may have changed."
    }

    # NOTE: We deliberately do NOT run `npm install` or install PowerShell 7 here.
    # start-portal.cmd already does both on first launch (and GitHub sign-in happens
    # in the Portal's web UI), so this installer stays lean: it just acquires the
    # release, ensures Node is present (to avoid start-portal's "install Node then
    # re-run" hop), and makes the app launchable. start-portal.cmd is the single
    # source of truth for runtime bootstrap.

    Progress 90 'Creating shortcuts...'
    $startCmd = Join-Path $InstallPath 'start-portal.cmd'
    if ($MakeStartMenu) {
        try {
            $sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'Copilot Portal.lnk'
            New-PortalShortcut -LinkPath $sm -Target $startCmd -WorkDir $InstallPath
            Emit 'Start Menu shortcut created.' 'OK'
        } catch { Emit "Start Menu shortcut skipped: $_" 'WARN' }
    }
    if ($MakeDesktop) {
        try {
            $dt = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Copilot Portal.lnk'
            New-PortalShortcut -LinkPath $dt -Target $startCmd -WorkDir $InstallPath
            Emit 'Desktop shortcut created.' 'OK'
        } catch { Emit "Desktop shortcut skipped: $_" 'WARN' }
    }

    Progress 100 'Done'
    Emit 'Copilot Portal is installed. Click "Open Portal" to finish setup and sign in.' 'OK'
}

# ---------------------------------------------------------------------------
# Shared: build the $sync bag and launch helper.
# ---------------------------------------------------------------------------
function New-SyncBag {
    $bag = [hashtable]::Synchronized(@{})
    $bag.Log         = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
    $bag.Percent     = 0
    $bag.Status      = 'Idle'
    $bag.Console     = $false
    $bag.Done        = $false
    $bag.Error       = $null
    $bag.InstallPath = $InstallPath
    return $bag
}

function Start-Portal {
    param([string]$Path)
    $cmd = Join-Path $Path 'start-portal.cmd'
    if (Test-Path $cmd) {
        Start-Process -FilePath $cmd -WorkingDirectory $Path
    }
}

# ===========================================================================
# SILENT MODE - run the engine synchronously with console logging.
# ===========================================================================
if ($Silent) {
    $sync = New-SyncBag
    $sync.Console = $true
    Write-Host "Copilot Portal installer (silent) - target: $InstallPath" -ForegroundColor Cyan
    try {
        & $Engine $sync $InstallPath $Repo $script:NODE_MIN (-not $NoStartMenu) (-not $NoDesktop)
        Write-Host "`nInstall complete." -ForegroundColor Green
        if ($Launch) { Write-Host 'Launching portal...' -ForegroundColor Cyan; Start-Portal -Path $sync.InstallPath }
        exit 0
    } catch {
        Write-Host "`nInstall FAILED: $_" -ForegroundColor Red
        exit 1
    }
}

# ===========================================================================
# GUI MODE - WPF window + background runspace + DispatcherTimer pump.
# ===========================================================================
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms   # FolderBrowserDialog

# DPI handling: intentionally NONE. We leave the process at its default
# (System-DPI-aware) and let Windows/DWM bitmap-scale the window when it moves
# between monitors of different scaling. This is the approach that works cleanly
# across displays (proven by CloudPC-Replace). Forcing Per-Monitor awareness
# (WinCPC-Tenant-Setup used SetProcessDpiAwareness) breaks scale switching, and
# manually handling WM_DPICHANGED from a PowerShell hook can deadlock the pump.
# SizeToContent + fixed inner heights (below) keep the layout correct.

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Copilot Portal - Installer" Width="640" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#0D1117" FontFamily="Segoe UI"
        TextOptions.TextFormattingMode="Display" TextOptions.TextRenderingMode="ClearType"
        UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Window.Resources>
    <Style x:Key="Accent" TargetType="Button">
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="Background" Value="#238636"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="4">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#2EA043"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bd" Property="Background" Value="#21262D"/>
                <Setter Property="Foreground" Value="#6E7681"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Margin="0">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- Header -->
    <Border Grid.Row="0" Background="#161B22" Padding="18,14">
      <StackPanel>
        <TextBlock Text="Copilot Portal" Foreground="#E6EDF3" FontSize="22" FontWeight="SemiBold"/>
        <TextBlock Text="Install the mobile-friendly web portal for GitHub Copilot CLI."
                   Foreground="#8B949E" FontSize="12" Margin="0,2,0,0"/>
      </StackPanel>
    </Border>

    <!-- Install location -->
    <StackPanel Grid.Row="1" Margin="18,16,18,0">
      <TextBlock Text="Install location" Foreground="#C9D1D9" FontSize="12" Margin="0,0,0,4"/>
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBox x:Name="txtPath" Grid.Column="0" Height="30" VerticalContentAlignment="Center"
                 Background="#0D1117" Foreground="#E6EDF3" BorderBrush="#30363D" Padding="6,0"/>
        <Button x:Name="btnBrowse" Grid.Column="1" Content="Browse..." Width="90" Height="30" Margin="8,0,0,0"/>
      </Grid>
    </StackPanel>

    <!-- Prereq status -->
    <Border Grid.Row="2" Margin="18,12,18,0" Background="#161B22" CornerRadius="4" Padding="12,8">
      <TextBlock x:Name="txtPrereq" Foreground="#8B949E" FontSize="12" Text="Checking prerequisites..."/>
    </Border>

    <!-- Options -->
    <StackPanel Grid.Row="3" Orientation="Horizontal" Margin="18,12,18,0">
      <CheckBox x:Name="chkStartMenu" Content="Start Menu shortcut" Foreground="#C9D1D9" IsChecked="True" Margin="0,0,20,0"/>
      <CheckBox x:Name="chkDesktop"   Content="Desktop shortcut"    Foreground="#C9D1D9" IsChecked="True"/>
    </StackPanel>

    <!-- Install button + progress -->
    <StackPanel Grid.Row="4" Margin="18,14,18,0">
      <Button x:Name="btnInstall" Content="Install" Height="38" FontSize="14" FontWeight="SemiBold"
              Style="{StaticResource Accent}"/>
      <ProgressBar x:Name="pbar" Height="6" Minimum="0" Maximum="100" Value="0" Margin="0,10,0,0"
                   Background="#161B22" Foreground="#2F81F7" BorderThickness="0"/>
      <TextBlock x:Name="txtStatus" Text="" Foreground="#8B949E" FontSize="11" Margin="0,4,0,0"/>
    </StackPanel>

    <!-- Log -->
    <Border Grid.Row="5" Height="150" Margin="18,10,18,0" Background="#010409" BorderBrush="#30363D" BorderThickness="1" CornerRadius="4">
      <ScrollViewer x:Name="scrollLog" VerticalScrollBarVisibility="Auto">
        <TextBox x:Name="txtLog" IsReadOnly="True" Background="Transparent" Foreground="#7EE787"
                 BorderThickness="0" FontFamily="Consolas" FontSize="11" TextWrapping="Wrap"
                 Padding="8" AcceptsReturn="True" VerticalScrollBarVisibility="Disabled"/>
      </ScrollViewer>
    </Border>

    <!-- Footer -->
    <StackPanel Grid.Row="6" Orientation="Horizontal" HorizontalAlignment="Right" Margin="18,12,18,16">
      <Button x:Name="btnOpen"  Content="Open Portal" Width="120" Height="32" Margin="0,0,8,0"
              Style="{StaticResource Accent}" IsEnabled="False"/>
      <Button x:Name="btnClose" Content="Close" Width="90" Height="32"/>
    </StackPanel>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

# Brand the window/taskbar/alt-tab chrome. The installer runs standalone (irm|iex),
# so there is no .ico on disk - the multi-size icon (16/24/32/48/64) is embedded as
# base64 below. Do NOT hand-edit this blob; regenerate it with tools\gen-icons.ps1
# after the logo changes.
$IconB64 = @'
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
Pv8/HUQTCAX0hdYAAAAASUVORK5CYII=
'@
try {
    $icoBytes = [Convert]::FromBase64String(($IconB64 -replace '\s',''))
    $ms = New-Object System.IO.MemoryStream (,$icoBytes)
    $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($ms,
        [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
        [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
    # Hand WPF a larger frame (48px) so titlebar (16) and taskbar (32) downscale
    # crisply rather than upscaling the 16px frame.
    $bestIcon = $dec.Frames | Sort-Object PixelWidth | Where-Object { $_.PixelWidth -le 48 } | Select-Object -Last 1
    if (-not $bestIcon) { $bestIcon = $dec.Frames[0] }
    $window.Icon = $bestIcon
} catch { }

$txtPath      = $window.FindName('txtPath')
$btnBrowse    = $window.FindName('btnBrowse')
$txtPrereq    = $window.FindName('txtPrereq')
$chkStartMenu = $window.FindName('chkStartMenu')
$chkDesktop   = $window.FindName('chkDesktop')
$btnInstall   = $window.FindName('btnInstall')
$pbar         = $window.FindName('pbar')
$txtStatus    = $window.FindName('txtStatus')
$txtLog       = $window.FindName('txtLog')
$scrollLog    = $window.FindName('scrollLog')
$btnOpen      = $window.FindName('btnOpen')
$btnClose     = $window.FindName('btnClose')

$txtPath.Text = $InstallPath
if ($NoStartMenu) { $chkStartMenu.IsChecked = $false }
if ($NoDesktop)   { $chkDesktop.IsChecked   = $false }

# Prereq status row (presence + floor, informational only).
try {
    $nodeTxt = 'not installed'
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $nv = (& node -v) 2>$null
        if ($nv -match 'v?(\d+\.\d+\.\d+)') {
            $ver = [version]$Matches[1]
            $nodeTxt = if ($ver -ge $script:NODE_MIN) { "$nv (ok)" } else { "$nv (will upgrade to >= $($script:NODE_MIN))" }
        }
    } else { $nodeTxt = "not installed (will install)" }
    $pwshTxt = if (Get-Command pwsh -ErrorAction SilentlyContinue) {
        $pv = (& pwsh -v) 2>$null   # e.g. "PowerShell 7.6.3"
        $pvNum = if ($pv -match '(\d+\.\d+\.\d+)') { $Matches[1] } else { $pv }
        "$pvNum (ok)"
    } else { 'not installed (will install)' }
    $txtPrereq.Text = "Node.js: $nodeTxt      PowerShell 7: $pwshTxt"
} catch { $txtPrereq.Text = 'Prerequisites will be checked during install.' }

# Shared state bag + runspace handles.
$sync = New-SyncBag
$script:rs     = $null
$script:ps     = $null
$script:handle = $null

# UI-thread pump: drains the log queue, updates progress, detects completion.
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
    while ($sync.Log.Count -gt 0) {
        $line = $sync.Log.Dequeue()
        $txtLog.AppendText($line + "`r`n")
        $txtLog.CaretIndex = $txtLog.Text.Length
        $scrollLog.ScrollToEnd()
    }
    $pbar.Value     = [double]$sync.Percent
    $txtStatus.Text = [string]$sync.Status

    if ($sync.Done) {
        $timer.Stop()
        if ($script:ps -and $script:handle) { try { $script:ps.EndInvoke($script:handle) } catch { } }
        if ($script:ps)  { $script:ps.Dispose() }
        if ($script:rs)  { $script:rs.Close(); $script:rs.Dispose() }
        if ($sync.Error) {
            $txtStatus.Text = "Failed: $($sync.Error)"
            $btnInstall.IsEnabled = $true
            $btnInstall.Content   = 'Retry'
        } else {
            $btnOpen.IsEnabled    = $true
            $btnInstall.Content   = 'Installed'
        }
    }
})

$btnBrowse.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Choose where to install Copilot Portal'
    $dlg.ShowNewFolderButton = $true
    try { if (Test-Path $txtPath.Text) { $dlg.SelectedPath = $txtPath.Text } } catch { }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        # Install into a copilot-portal subfolder unless they already pointed at one.
        $sel = $dlg.SelectedPath
        if ((Split-Path $sel -Leaf) -notmatch 'copilot-portal') { $sel = Join-Path $sel 'copilot-portal' }
        $txtPath.Text = $sel
    }
})

$btnInstall.Add_Click({
    $target = $txtPath.Text.Trim()
    if (-not $target) { [System.Windows.MessageBox]::Show('Please choose an install location.', 'Copilot Portal') | Out-Null; return }

    $btnInstall.IsEnabled = $false
    $btnInstall.Content   = 'Installing...'
    $btnBrowse.IsEnabled  = $false
    $txtPath.IsEnabled    = $false
    $sync.Done = $false; $sync.Error = $null; $sync.Percent = 0

    $mkSM = [bool]$chkStartMenu.IsChecked
    $mkDT = [bool]$chkDesktop.IsChecked

    # Background runspace (STA) runs the engine; the DispatcherTimer surfaces it.
    $script:rs = [runspacefactory]::CreateRunspace()
    $script:rs.ApartmentState = 'STA'
    $script:rs.ThreadOptions  = 'ReuseThread'
    $script:rs.Open()
    $script:rs.SessionStateProxy.SetVariable('sync', $sync)

    $script:ps = [powershell]::Create()
    $script:ps.Runspace = $script:rs
    # Wrap the engine so any throw is captured into $sync and Done is always set.
    # NOTE: we pass the engine as TEXT and rebuild it with [scriptblock]::Create
    # INSIDE this runspace. A scriptblock keeps affinity to the session state where
    # it was created; when the installer is run via `irm | iex`, $Engine's origin
    # session can't resolve core cmdlets (Test-Path, Join-Path, ...) from this
    # background runspace, so it fails with "term not recognized". Recreating it
    # here binds it to this runspace's default session state, which has them.
    [void]$script:ps.AddScript({
        param($EngineText, $sync, $InstallPath, $Repo, $NodeMin, $MakeStartMenu, $MakeDesktop)
        try {
            $Engine = [scriptblock]::Create($EngineText)
            & $Engine $sync $InstallPath $Repo $NodeMin $MakeStartMenu $MakeDesktop
        } catch {
            $sync.Error = $_.ToString()
            try { $sync.Log.Enqueue('[FAIL] ' + $_.ToString()) } catch { }
        } finally {
            $sync.Done = $true
        }
    })
    [void]$script:ps.AddArgument($Engine.ToString())
    [void]$script:ps.AddArgument($sync)
    [void]$script:ps.AddArgument($target)
    [void]$script:ps.AddArgument($Repo)
    [void]$script:ps.AddArgument($script:NODE_MIN)
    [void]$script:ps.AddArgument($mkSM)
    [void]$script:ps.AddArgument($mkDT)

    $script:handle = $script:ps.BeginInvoke()
    $timer.Start()
})

$btnOpen.Add_Click({
    Start-Portal -Path $sync.InstallPath
    $window.Close()
})
$btnClose.Add_Click({ $window.Close() })

$window.Add_Closed({
    try { if ($timer) { $timer.Stop() } } catch { }
    try { if ($script:ps) { $script:ps.Dispose() } } catch { }
    try { if ($script:rs) { $script:rs.Close(); $script:rs.Dispose() } } catch { }
})

[void]$window.ShowDialog()
