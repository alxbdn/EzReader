# Build MSIX package for Microsoft Store submission
# Requires Windows SDK (makeappx.exe)

param(
    [switch]$SkipBuild,
    [string]$Version = "",
    [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

# Configuration
$AppName = "ezreader"
$ExeName = "ezreader-portable"
# Name of the executable inside the package (the Store install is not the portable app)
$PackagedExeName = "EzReader"
# The .msix lands in store\ (git-ignored): it is only uploaded to the Microsoft
# Store, never published on GitHub.
$OutputDir = ".\store"
$PackageDir = ".\target\msix-package"

# Get version from tauri.conf.json if not provided
if (-not $Version) {
    $conf = Get-Content ".\src-tauri\tauri.conf.json" | ConvertFrom-Json
    $Version = $conf.version
}
# MSIX requires 4-part version
if (($Version -split '\.').Count -lt 4) {
    $Version = "$Version.0"
}

Write-Host "Building MSIX v$Version" -ForegroundColor Cyan

# Find makeappx.exe from Windows SDK
$makeappx = $null
$sdkBase = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
if (Test-Path $sdkBase) {
    $versions = Get-ChildItem $sdkBase -Directory | Sort-Object Name -Descending
    foreach ($ver in $versions) {
        $candidate = Join-Path $ver.FullName "x64\makeappx.exe"
        if (Test-Path $candidate) {
            $makeappx = $candidate
            break
        }
    }
}

if (-not $makeappx) {
    Write-Error "makeappx.exe not found. Please install Windows SDK from https://developer.microsoft.com/windows/downloads/windows-sdk/"
    exit 1
}

Write-Host "Using makeappx: $makeappx" -ForegroundColor Cyan

# Step 1: Build Tauri app
if (-not $SkipBuild) {
    Write-Host "`n=== Building Tauri application ===" -ForegroundColor Green
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tauri build failed"
        exit 1
    }
}

# Step 2: Create package directory structure
Write-Host "`n=== Creating MSIX package structure ===" -ForegroundColor Green

if (Test-Path $PackageDir) {
    Remove-Item $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path $PackageDir -Force | Out-Null
New-Item -ItemType Directory -Path "$PackageDir\icons" -Force | Out-Null

# Step 3: Copy built application files
$buildDir = ".\src-tauri\target\release"
if (-not (Test-Path $buildDir)) {
    Write-Error "Build directory not found: $buildDir"
    exit 1
}

Write-Host "Copying application files..." -ForegroundColor Yellow
Copy-Item "$buildDir\$ExeName.exe" "$PackageDir\$PackagedExeName.exe" -Force

# Copy any DLLs
Get-ChildItem "$buildDir\*.dll" | ForEach-Object {
    Copy-Item $_.FullName "$PackageDir\" -Force
}

# Explorer add-in (PDF thumbnails and preview pane), registered by the
# manifest. Built by `npm run build:shell-ext` (part of the Windows build).
$shellDll = ".\src-tauri\shell-ext\target\release\ezreader_shell.dll"
if (-not (Test-Path $shellDll)) {
    Write-Error "Explorer add-in not found: $shellDll (run npm run build:shell-ext)"
    exit 1
}
Copy-Item $shellDll "$PackageDir\" -Force

# Step 4: Copy icons
Write-Host "Copying icons..." -ForegroundColor Yellow
$iconFiles = @(
    "StoreLogo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square150x150Logo.png",
    "Square310x310Logo.png"
)

foreach ($icon in $iconFiles) {
    $src = ".\src-tauri\icons\$icon"
    if (Test-Path $src) {
        Copy-Item $src "$PackageDir\icons\" -Force
    } else {
        Write-Warning "Icon not found: $icon"
    }
}

# Taskbar / Start icons at each target size, plated and unplated. Without the
# unplated ones Windows draws the icon on a square in the accent colour.
Copy-Item ".\src-tauri\icons\msix\*.png" "$PackageDir\icons\" -Force

# Step 5: Copy and update manifest with version
Write-Host "Copying manifest..." -ForegroundColor Yellow
# Read manifest, update version, write without BOM (makeappx requires no BOM)
$manifestPath = Resolve-Path ".\src-tauri\AppxManifest.xml"
$outPath = Join-Path (Resolve-Path $PackageDir).Path "AppxManifest.xml"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifest = [System.IO.File]::ReadAllText($manifestPath.Path, $utf8NoBom)
# Case-sensitive replace to avoid touching <?xml version="1.0"...>
# Only replace the Identity Version="0.0.0.0", not MinVersion/MaxVersionTested
$manifest = $manifest -creplace 'Version="0\.0\.0\.0"', "Version=`"$Version`""
[System.IO.File]::WriteAllText($outPath, $manifest, $utf8NoBom)

# Step 5b: Index the icon variants in resources.pri, so Windows can pick the
# targetsize / unplated files (it ignores them without an index)
Write-Host "Indexing resources..." -ForegroundColor Yellow
$makepri = Join-Path (Split-Path $makeappx) "makepri.exe"
$priConfig = "$OutputDir\priconfig.xml"
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "makepri createconfig failed"; exit 1 }
& $makepri new /pr $PackageDir /cf $priConfig /mn $outPath /of "$PackageDir\resources.pri" /o
if ($LASTEXITCODE -ne 0) { Write-Error "makepri new failed"; exit 1 }

# Step 6: Create MSIX package
Write-Host "`n=== Creating MSIX package ===" -ForegroundColor Green
$msixFile = "$OutputDir\EzReader_${Version}_${Architecture}.msix"

& $makeappx pack /d $PackageDir /p $msixFile /o

if ($LASTEXITCODE -ne 0) {
    Write-Error "makeappx failed"
    exit 1
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Green
Write-Host "MSIX package created: $msixFile" -ForegroundColor Cyan
