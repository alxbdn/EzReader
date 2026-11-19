param([string]$Out = "$env:RUNNER_TEMP\trailer")

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll")] public static extern int EnumDisplaySettings(string d, int m, ref DEVMODE dm);
  [DllImport("user32.dll")] public static extern int ChangeDisplaySettings(ref DEVMODE dm, int f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);
  public static int SetRes(int w, int h) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettings(null, -1, ref dm);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref dm, 1);
  }
  public static void Key(byte vk) { keybd_event(vk, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(40); keybd_event(vk, 0, 2, IntPtr.Zero); }
}
"@
[W]::SetProcessDPIAware() | Out-Null
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint t, ref GUITHREADINFO g);
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize, flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT rc; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Desc(IntPtr h) {
    var t = new StringBuilder(256); GetWindowText(h, t, 256); RECT r; GetWindowRect(h, out r); uint pid; GetWindowThreadProcessId(h, out pid);
    string pn = ""; try { pn = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return String.Format("{0} [{1}] '{2}' {3},{4} {5}x{6} vis={7} pid={8}", Cls(h), pn, t, r.L, r.T, r.R - r.L, r.B - r.T, IsWindowVisible(h), pid);
  }
  public static string Dump() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r); if (r.R - r.L < 2) return true;
      sb.AppendLine(Desc(h));
      EnumChildWindows(h, (c, l2) => { var k = Cls(c); if (k.StartsWith("EzReader") || k == "PreviewHandlerFrame" || k == "SHELLDLL_DefView" || k == "DirectUIHWND") sb.AppendLine("    " + Desc(c)); return true; }, IntPtr.Zero);
      return true; }, IntPtr.Zero);
    var fg = GetForegroundWindow(); uint pid; uint tid = GetWindowThreadProcessId(fg, out pid);
    var g = new GUITHREADINFO(); g.cbSize = Marshal.SizeOf(g); GetGUIThreadInfo(tid, ref g);
    sb.AppendLine("FOREGROUND " + Desc(fg));
    sb.AppendLine("FOCUS " + (g.focus == IntPtr.Zero ? "none" : Desc(g.focus)));
    return sb.ToString();
  }
}
"@
function Dump($tag) { Write-Host "--- windows: $tag ---"; Write-Host ([Win]::Dump()) }


function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Shot($name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save("$Out\$name.png"); $g.Dispose(); $bmp.Dispose()
}

# --- Screen, theme, clutter -------------------------------------------------
Step "Display 1920x1080"
Write-Host "ChangeDisplaySettings -> $([W]::SetRes(1920, 1080))"
Start-Sleep 2
Write-Host "Screen now: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)"

Step "Dark mode, plain wallpaper"
$p = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
New-Item -Force $p | Out-Null
Set-ItemProperty $p AppsUseLightTheme 0 -Type DWord
Set-ItemProperty $p SystemUsesLightTheme 0 -Type DWord
Set-ItemProperty $p EnableTransparency 0 -Type DWord
Set-ItemProperty "HKCU:\Control Panel\Colors" Background "9 9 11"
[W]::SystemParametersInfo(0x14, 0, "", 3) | Out-Null
$adv = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
Set-ItemProperty $adv HideFileExt 1 -Type DWord
Set-ItemProperty $adv ShowInfoTip 0 -Type DWord
Set-ItemProperty $adv TaskbarSmallIcons 0 -Type DWord
Get-Process ServerManager, msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep 3
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe; Start-Sleep 4 }

# --- Install EzReader --------------------------------------------------------
Step "Install EzReader"
$setup = Get-ChildItem "$env:RUNNER_TEMP\rel" -Filter "*-setup.exe" | Select-Object -First 1
$pr = Start-Process $setup.FullName -ArgumentList "/S" -Wait -PassThru
Write-Host "setup exit $($pr.ExitCode)"
$keys = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
$inst = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "EzReader" } | Select-Object -First 1
$dir = $inst.InstallLocation
if (-not $dir) { $dir = Split-Path ($inst.UninstallString -replace '"', '') }
$dir = $dir.Trim('"')
Write-Host "installed in $dir"
Get-ChildItem $dir | Format-Table Name, Length | Out-Host
$helper = Join-Path $dir "ezreader-quicklook.exe"
Start-Process $helper
Start-Sleep 2
Write-Host "quick look running: $([bool](Get-Process ezreader-quicklook -ErrorAction SilentlyContinue))"

# --- Demo folder ------------------------------------------------------------
$docs = "$env:USERPROFILE\Documents\Paperwork"
New-Item -ItemType Directory -Force $docs | Out-Null
Copy-Item "$PSScriptRoot\demo\*.pdf" $docs
# Make sure the thumbnail cache is warm before recording.
Start-Process explorer.exe $docs
Start-Sleep 6
Get-Process explorer | Where-Object MainWindowTitle | ForEach-Object { Write-Host "window: $($_.MainWindowTitle)" }

# --- Diagnostics --------------------------------------------------------------
Step "Diagnostics"
Write-Host "OS: $((Get-CimInstance Win32_OperatingSystem).Caption) $([Environment]::OSVersion.Version)"
Write-Host "Windows.Data.Pdf.dll: $(Test-Path "$env:windir\System32\Windows.Data.Pdf.dll")"
try {
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  Write-Host "WinRT PdfDocument type loads"
} catch { Write-Host "WinRT PdfDocument type: $_" }
$pv = Start-Process $helper -ArgumentList "--preview", "`"$docs\Garden plan.pdf`"" -PassThru
Start-Sleep 5
Shot "diag-preview-one"
Write-Host "preview-one alive: $(-not $pv.HasExited)"
if (-not $pv.HasExited) { $pv | Stop-Process -Force }
Get-ItemProperty "HKCU:\Software\Classes\.pdf\ShellEx\*" -ErrorAction SilentlyContinue | Format-List | Out-Host
Get-ItemProperty "HKCU:\Software\Classes\.pdf" -ErrorAction SilentlyContinue | Format-List | Out-Host
Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" -ErrorAction SilentlyContinue | Format-List | Out-Host
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" -ErrorAction SilentlyContinue | Format-List | Out-Host
Get-ItemProperty "HKCR:\.pdf" -ErrorAction SilentlyContinue | Out-Null
cmd /c "reg query HKCR\.pdf /s" | Out-Host

# --- UI Automation helpers -------------------------------------------------
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Explorer-Window {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "CabinetWClass")
  $AE::RootElement.FindFirst($TS::Children, $cond)
}
function Item($win, $name) {
  $c = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)))
  $win.FindFirst($TS::Descendants, $c)
}
$script:cx = 900; $script:cy = 900
function Glide($x, $y, $ms = 700) {
  $n = [int]($ms / 12); $x0 = $script:cx; $y0 = $script:cy
  for ($i = 1; $i -le $n; $i++) {
    $t = $i / $n; $e = if ($t -lt .5) { 4 * $t * $t * $t } else { 1 - [math]::Pow(-2 * $t + 2, 3) / 2 }
    [W]::SetCursorPos([int]($x0 + ($x - $x0) * $e), [int]($y0 + ($y - $y0) * $e)) | Out-Null
    Start-Sleep -Milliseconds 12
  }
  $script:cx = $x; $script:cy = $y
}
function Click { [W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 70; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero) }
function ClickItem($win, $name, $ms = 800) {
  $it = Item $win $name
  if (-not $it) { Write-Warning "no item $name"; return }
  $r = $it.Current.BoundingRectangle
  Glide ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height * .45)) $ms
  Start-Sleep -Milliseconds 120
  Click
}

# --- Set the Explorer window up: maximized, large icons, preview pane -------
Step "Arrange Explorer"
$win = Explorer-Window
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
[W]::ShowWindow($hwnd, 3) | Out-Null
[W]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep 1
$sh = New-Object -ComObject WScript.Shell
$sh.SendKeys("^+2")          # Large icons
Start-Sleep 1
$sh.SendKeys("%p")           # Preview pane
Start-Sleep 2
# The live helper's Space hook hangs on this runner (SetForegroundWindow while
# attached to Explorer's input), so stop it and open Quick Look with --preview.
& $helper --stop; Start-Sleep 1
Get-Process ezreader-quicklook -ErrorAction SilentlyContinue | Stop-Process -Force
# Widen the preview pane by dragging its splitter.
$pane = $null
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "SHELLDLL_DefView")
$view = $win.FindFirst($TS::Descendants, $cond)
$vr = $view.Current.BoundingRectangle
Write-Host "file view: $vr"
$sx = [int]($vr.X + $vr.Width + 2)
[W]::SetCursorPos($sx, 600) | Out-Null; Start-Sleep -Milliseconds 300
[W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
for ($x = $sx; $x -ge 1060; $x -= 20) { [W]::SetCursorPos($x, 600) | Out-Null; Start-Sleep -Milliseconds 15 }
[W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep 1
Write-Host "file view after drag: $($view.Current.BoundingRectangle)"
# Warm-up pass so the preview host and thumbnails are loaded.
$i = 0
foreach ($n in "Lease agreement", "Pride and Prejudice", "Receipt", "Garden plan", "Library letter") {
  ClickItem $win $n 200; Start-Sleep 5; Shot ("warm-{0}" -f $i++)
}
Dump "after warm-up"
[W]::SetCursorPos(900, 900) | Out-Null; Click
Start-Sleep 2
Shot "00-setup"

# --- Record ------------------------------------------------------------------
Step "Record"
$psi = New-Object System.Diagnostics.ProcessStartInfo "ffmpeg"
$psi.Arguments = "-y -loglevel error -f gdigrab -framerate 30 -draw_mouse 1 -i desktop -c:v libx264 -preset veryfast -crf 14 -pix_fmt yuv420p `"$Out\explorer-quicklook.mp4`""
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$ff = [System.Diagnostics.Process]::Start($psi)
Start-Sleep 2
$t0 = Get-Date
$marks = [ordered]@{}
function Mark($n) { $marks[$n] = [math]::Round(((Get-Date) - $t0).TotalSeconds + 2, 2) }

# Scene 2: hover through the folder, the preview pane shows each first page.
Mark "s2-start"
ClickItem $win "Lease agreement" 900;  Start-Sleep -Milliseconds 1500
ClickItem $win "Pride and Prejudice" 600; Start-Sleep -Milliseconds 1500
ClickItem $win "Receipt" 600;          Start-Sleep -Milliseconds 1500
Shot "01-preview"
Dump "receipt selected"
# Scene 3: Space opens Quick Look on the garden plan, arrows turn pages.
Mark "s3-start"
ClickItem $win "Garden plan" 700;      Start-Sleep -Milliseconds 900
Dump "before space"
Mark "space-open"
[W]::Key(0x20)
$ql = Start-Process $helper -ArgumentList "--preview", "`"$docs\Garden plan.pdf`"" -PassThru
Start-Sleep -Milliseconds 1800
Shot "02-quicklook"
Dump "after space"
Get-Process ezreader-quicklook -ErrorAction SilentlyContinue | Format-Table Id, Responding, CPU | Out-Host
[W]::Key(0x28);                        Start-Sleep -Milliseconds 900
[W]::Key(0x28);                        Start-Sleep -Milliseconds 1200
Mark "space-close"
[W]::Key(0x20);                        Start-Sleep -Milliseconds 400
if (-not $ql.HasExited) { Write-Host "Quick Look still open after Space, closing it"; $ql | Stop-Process -Force }
Start-Sleep -Milliseconds 1100
Shot "03-closed"
Mark "end"

$ff.StandardInput.Write("q"); $ff.StandardInput.Close()
$ff.WaitForExit(20000) | Out-Null
Start-Sleep 5
Shot "04-later"
Get-Process ezreader-quicklook, prevhost -ErrorAction SilentlyContinue | Format-Table Id, Name, Responding, CPU | Out-Host
$cdb = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64\cdb.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host "cdb: $($cdb.FullName)"
foreach ($pn in "ezreader-quicklook", "prevhost") {
  foreach ($proc in Get-Process $pn -ErrorAction SilentlyContinue) {
    Write-Host "##### stacks of $pn $($proc.Id) #####"
    if ($cdb) { & $cdb.FullName -p $proc.Id -pv -c ".symfix c:\sym; .reload; ~*kn 40; qd" 2>&1 | Select-String -NotMatch "^\s*$" | Select-Object -Last 150 | Out-Host }
  }
}
$marks | ConvertTo-Json | Set-Content "$Out\marks.json"
Get-Content "$Out\marks.json" | Out-Host
Get-ChildItem $Out | Format-Table Name, Length | Out-Host
