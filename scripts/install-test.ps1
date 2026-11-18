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

function V($v) { [version](($v -split '-')[0]) }
function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Check($ok, $text) {
    if ($ok) { Write-Host "  ok   $text" -ForegroundColor Green }
    else { Write-Host "  FAIL $text" -ForegroundColor Red; $failures.Add($text) }
}

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

$shellDll = Join-Path ($install.InstallLocation -replace '"', '') "ezreader_shell.dll"
$thumbClsid = "{5AE37068-61BA-478F-9D24-EA58E7C1EBF6}"
$previewClsid = "{202348CF-BD0B-4EB3-91B2-C87E74F2FD32}"
$pdfShellEx = "HKCU:\Software\Classes\.pdf\ShellEx"
function Get-Default($key) { (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)' }
Check (Test-Path $shellDll) "the Explorer add-in is in the install folder"
Check (Test-Path (Join-Path (Split-Path $shellDll) "ezreader-quicklook.exe")) "the quick-look helper is in the install folder"
Check ((Get-Default "$pdfShellEx\{e357fccd-a995-4576-b01f-234630154e96}") -eq $thumbClsid) "PDF thumbnails are registered"
Check ((Get-Default "$pdfShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}") -eq $previewClsid) "the PDF preview handler is registered"
Check ((Get-Default "HKCU:\Software\Classes\CLSID\$thumbClsid\InprocServer32") -eq $shellDll) "the thumbnail class points to the add-in"

Step "NSIS: uninstall"
$uninstaller = ($install.UninstallString -replace '"', '')
$p = Start-Process $uninstaller -ArgumentList "/S" -Wait -PassThru
for ($i = 0; $i -lt 30 -and (Get-NsisInstall); $i++) { Start-Sleep -Seconds 1 }
Check ($null -eq (Get-NsisInstall)) "EzReader is gone from Installed apps"
if ($exe) {
    for ($i = 0; $i -lt 15 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
    Check (-not (Test-Path $exe.FullName)) "the program file was removed"
}
Check (-not (Test-Path "$pdfShellEx\{e357fccd-a995-4576-b01f-234630154e96}")) "PDF thumbnails are unregistered"
Check (-not (Test-Path "HKCU:\Software\Classes\CLSID\$previewClsid")) "the PDF preview handler is unregistered"

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
    Check (Test-Path (Join-Path $pkg.InstallLocation "ezreader_shell.dll")) "the Explorer add-in is in the package"
    Check (Test-Path (Join-Path $pkg.InstallLocation "ezreader-quicklook.exe")) "the quick-look helper is in the package"
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
