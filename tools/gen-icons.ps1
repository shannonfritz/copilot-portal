<#
.SYNOPSIS
    Regenerates the Copilot Portal icon artifacts from the source app-icon PNG.

.DESCRIPTION
    Single source of truth: webui\public\icon-512x512.png (the dark rounded-square
    app icon). From it this script (re)builds, deterministically:

      1. webui\public\favicon.ico            - multi-size .ico (16..256) that vite
                                                copies into dist\webui\ and ships in
                                                every release zip. Used as the Start
                                                Menu / Desktop shortcut icon.
      2. The $IconB64 here-string inside      - a compact multi-size .ico (16..64)
         Install-CopilotPortal.ps1              base64-embedded so the standalone
                                                (irm|iex) installer can set its
                                                window/taskbar icon with no file on disk.

    Run this whenever the logo changes (rare). NEVER hand-edit the base64 blob in the
    installer - always regenerate here so the bytes stay exact.

    Windows-only (uses System.Drawing). No npm dependencies. The maintainer builds and
    packages Copilot Portal on Windows, so this needs no rasterizer or CI image tooling.

.EXAMPLE
    pwsh -File tools\gen-icons.ps1
    powershell -File tools\gen-icons.ps1
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string]$IcoOut,
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Resolve the script's own directory (robust across PS 5.1 / pwsh and -File / dot-source).
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Source)    { $Source    = Join-Path $root '..\webui\public\icon-512x512.png' }
if (-not $IcoOut)    { $IcoOut    = Join-Path $root '..\webui\public\favicon.ico' }
if (-not $Installer) { $Installer = Join-Path $root '..\Install-CopilotPortal.ps1' }

$Source    = [System.IO.Path]::GetFullPath($Source)
$IcoOut    = [System.IO.Path]::GetFullPath($IcoOut)
$Installer = [System.IO.Path]::GetFullPath($Installer)
if (-not (Test-Path $Source)) { throw "Source PNG not found: $Source" }

function New-IcoBytes {
    param([System.Drawing.Bitmap]$Bmp, [int[]]$Sizes)
    $blobs = @()
    foreach ($s in $Sizes) {
        $b = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($b)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($Bmp, 0, 0, $s, $s)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $b.Dispose()
        $blobs += ,($ms.ToArray())
        $ms.Dispose()
    }
    $n  = $blobs.Count
    $fs = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$n)  # ICONDIR
    $offset = 6 + (16 * $n)
    for ($i = 0; $i -lt $n; $i++) {
        $blob = $blobs[$i]; $s = $Sizes[$i]
        $wb = if ($s -ge 256) { 0 } else { $s }   # 0 encodes 256 in ICONDIRENTRY
        $bw.Write([Byte]$wb); $bw.Write([Byte]$wb); $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]$blob.Length); $bw.Write([UInt32]$offset)
        $offset += $blob.Length
    }
    foreach ($blob in $blobs) { $bw.Write($blob) }
    $bw.Flush()
    $bytes = $fs.ToArray()
    $bw.Dispose(); $fs.Dispose()
    return ,$bytes
}

$src = [System.Drawing.Bitmap]::FromFile($Source)
try {
    # 1. Full multi-size .ico for the shipped shortcut icon.
    $full = New-IcoBytes -Bmp $src -Sizes @(16,24,32,48,64,128,256)
    [System.IO.File]::WriteAllBytes($IcoOut, $full)
    Write-Host ("Wrote {0} ({1} bytes)" -f $IcoOut, $full.Length)

    # 2. Compact .ico -> base64 for the installer window icon (window chrome only,
    #    so 128/256 are unnecessary weight).
    $slim = New-IcoBytes -Bmp $src -Sizes @(16,24,32,48,64)
    $b64  = [Convert]::ToBase64String($slim)
    $wrapped = ($b64 -split '(.{120})' | Where-Object { $_ }) -join "`r`n"
} finally {
    $src.Dispose()
}

# Splice the base64 into the installer's $IconB64 here-string, preserving the UTF-8 BOM.
$raw = Get-Content $Installer -Raw
$pattern = "(?s)(\`$IconB64 = @')(.*?)('@)"
if (-not [System.Text.RegularExpressions.Regex]::IsMatch($raw, $pattern)) {
    throw "Could not find the `$IconB64 = @'...'@ block in $Installer"
}
$replacement = "`$IconB64 = @'`r`n$wrapped`r`n'@"
$new = [System.Text.RegularExpressions.Regex]::Replace($raw, $pattern, { param($m) $replacement })
if ($new -ne $raw) {
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($Installer, $new, $enc)
    Write-Host ("Embedded {0}-byte icon ({1} base64 chars) into {2}" -f $slim.Length, $b64.Length, $Installer)
} else {
    Write-Host "Installer base64 already up to date (no change)."
}

Write-Host "Done. Rebuild the webui (npm run build:ui) so dist\webui\favicon.ico refreshes."
