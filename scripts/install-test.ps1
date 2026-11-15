# Install test on a clean Windows machine (CI runner), before a release:
#
#   1. installs the previous release (NSIS installer, then MSIX),
#   2. upgrades it to the new build and checks the new version is in place,
#   3. starts the installed app on a PDF and checks it stays up,
#   4. uninstalls it and checks nothing is left behind.
#
#   scripts/install-test.ps1 -Setup <new setup.exe> -Msix <new .msix> -Version 1.2.3
#
# The previous release is downloaded from GitHub (gh CLI, GH_TOKEN). Without
# one (first release, or no network) the upgrade step is skipped, not failed.
# The Store signs the MSIX; here it is signed with a throwaway certificate
# whose subject matches the manifest's Publisher, trusted on this machine only.

param(
    [Parameter(Mandatory)] [string]$Setup,
    [Parameter(Mandatory)] [string]$Msix,
    [Parameter(Mandatory)] [string]$Version,
    [string]$Repo = $env:GITHUB_REPOSITORY,
    [string]$Pdf = "src-tauri/tests/corpus/pdf14-mixed-sizes-rotated.pdf"
)

$ErrorActionPreference = "Stop"
$Setup = (Resolve-Path $Setup).Path
$Msix = (Resolve-Path $Msix).Path
$Pdf = (Resolve-Path $Pdf).Path
$work = Join-Path $env:RUNNER_TEMP "install-test"
New-Item -ItemType Directory -Force $work | Out-Null
$failures = [System.Collections.Generic.List[string]]::new()

# Compares release versions, ignoring a pre-release suffix (1.2.0-beta).
function V($v) { [version](($v -split '-')[0]) }
function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Check($ok, $text) {
    if ($ok) { Write-Host "  ok   $text" -ForegroundColor Green }
    else { Write-Host "  FAIL $text" -ForegroundColor Red; $failures.Add($text) }
}

# ── Previous release ──────────────────────────────────────────────────────────

function Get-PreviousRelease {
    if (-not $Repo -or -not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }
    try {
        $tag = gh api "repos/$Repo/releases/latest" --jq .tag_name 2>$null
        if (-not $tag -or $LASTEXITCODE -ne 0) { return $null }
        $dir = Join-Path $work "previous"
        New-Item -ItemType Directory -Force $dir | Out-Null
        gh release download $tag --repo $Repo --dir $dir --pattern "*-setup.exe" --pattern "*.msix" --clobber
        if ($LASTEXITCODE -ne 0) { return $null }
        return [pscustomobject]@{
            Tag = $tag
            Version = $tag.TrimStart("v")
            Setup = Get-ChildItem $dir -Filter "*-setup.exe" | Select-Object -First 1 -ExpandProperty FullName
            Msix = Get-ChildItem $dir -Filter "*.msix" | Select-Object -First 1 -ExpandProperty FullName
        }
    } catch {
        Write-Warning "No previous release: $_"
        return $null
    }
}

# ── NSIS installer ────────────────────────────────────────────────────────────

$uninstallKeys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

function Get-NsisInstall {
    Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "EzReader" } | Select-Object -First 1
}

function Get-InstalledExe($install) {
    $dir = $install.InstallLocation
    if (-not $dir) { $dir = Split-Path ($install.UninstallString -replace '"', '') }
    $dir = $dir.Trim('"')
    Get-ChildItem $dir -Filter *.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '^uninstall' } | Select-Object -First 1
}

function Install-Nsis($path) {
    $p = Start-Process $path -ArgumentList "/S" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "installer $path exited with $($p.ExitCode)" }
}

# Starts the installed app on a PDF: it must still be running a few seconds
# later (no crash at start, no missing DLL), then it is closed.
function Test-Launch($start, $name) {
    $before = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    & $start
    Start-Sleep -Seconds 8
    $proc = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $before -notcontains $_.Id -and ($_.ProcessName -match 'ezreader') }
    Check ($null -ne $proc) "$name starts and keeps running on a PDF"
    $proc | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

$previous = Get-PreviousRelease
if ($previous) { Write-Host "Previous release: $($previous.Tag)" } else { Write-Warning "No previous release found: the upgrade steps are skipped." }

Step "NSIS: install"
if ($previous -and $previous.Setup -and ((V $previous.Version) -lt (V $Version))) {
    Install-Nsis $previous.Setup
    $old = Get-NsisInstall
    Check ($old -and $old.DisplayVersion -eq $previous.Version) "previous release $($previous.Version) installed"
    Step "NSIS: upgrade to $Version"
}
Install-Nsis $Setup
$install = Get-NsisInstall
Check ($null -ne $install) "EzReader is listed in Installed apps"
Check ($install.DisplayVersion -eq $Version) "installed version is $Version (found $($install.DisplayVersion))"
$exe = Get-InstalledExe $install
Check ($null -ne $exe) "the program file is in the install folder ($($install.InstallLocation))"
$dupes = @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "EzReader" })
Check ($dupes.Count -eq 1) "a single EzReader entry after the upgrade (found $($dupes.Count))"
if ($exe) { Test-Launch { Start-Process $exe.FullName -ArgumentList "`"$Pdf`"" } "installed EzReader" }

Step "NSIS: uninstall"
$uninstaller = ($install.UninstallString -replace '"', '')
$p = Start-Process $uninstaller -ArgumentList "/S" -Wait -PassThru
# The NSIS uninstaller copies itself to TEMP and returns at once: wait for it.
for ($i = 0; $i -lt 30 -and (Get-NsisInstall); $i++) { Start-Sleep -Seconds 1 }
Check ($null -eq (Get-NsisInstall)) "EzReader is gone from Installed apps"
if ($exe) {
    for ($i = 0; $i -lt 15 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
    Check (-not (Test-Path $exe.FullName)) "the program file was removed"
}

# ── MSIX ──────────────────────────────────────────────────────────────────────

Step "MSIX: signing with a test certificate"
$manifest = [xml](Get-Content src-tauri/AppxManifest.xml)
$publisher = $manifest.Package.Identity.Publisher
$packageName = $manifest.Package.Identity.Name
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
    -FriendlyName "EzReader install test" -CertStoreLocation "Cert:\CurrentUser\My" `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
$cer = Join-Path $work "test.cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
function Sign($path) {
    $copy = Join-Path $work ("signed-" + (Split-Path $path -Leaf))
    Copy-Item $path $copy -Force
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $copy | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "signtool failed on $path" }
    return $copy
}
$msixVersion = if (($Version -split '\.').Count -lt 4) { "$Version.0" } else { $Version }

Step "MSIX: install"
if ($previous -and $previous.Msix -and ((V $previous.Version) -lt (V $Version))) {
    Add-AppxPackage -Path (Sign $previous.Msix)
    $old = Get-AppxPackage -Name $packageName
    Check ($null -ne $old) "previous release $($previous.Version) installed ($($old.Version))"
    Step "MSIX: upgrade to $msixVersion"
}
Add-AppxPackage -Path (Sign $Msix)
$pkg = Get-AppxPackage -Name $packageName
Check ($null -ne $pkg) "the package is installed"
Check ($pkg.Version -eq $msixVersion) "installed version is $msixVersion (found $($pkg.Version))"
Check (@($pkg).Count -eq 1) "a single version installed after the upgrade"
if ($pkg) {
    Check (Test-Path (Join-Path $pkg.InstallLocation "EzReader.exe")) "EzReader.exe is in the package"
    $family = $pkg.PackageFamilyName
    Test-Launch { Start-Process "explorer.exe" "shell:AppsFolder\$family!App" } "the Store app"
}

Step "MSIX: uninstall"
if ($pkg) { Remove-AppxPackage -Package $pkg.PackageFullName }
Check ($null -eq (Get-AppxPackage -Name $packageName)) "the package is removed"

Get-ChildItem "Cert:\LocalMachine\TrustedPeople" | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"

if ($failures.Count) {
    Write-Host "`n$($failures.Count) check(s) failed:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nInstall, upgrade, launch and uninstall: all checks passed." -ForegroundColor Green
