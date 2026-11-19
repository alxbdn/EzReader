param([string]$Out = "$env:TEMP\ezreader-trailer", [string]$Docs = "$([Environment]::GetFolderPath('MyDocuments'))\Paperwork")

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
  public static int[] ChildRect(IntPtr top, string cls) {
    int[] res = null;
    EnumChildWindows(top, (c, l) => { if (res == null && Cls(c) == cls && IsWindowVisible(c)) { RECT r; GetWindowRect(c, out r); res = new int[] { r.L, r.T, r.R, r.B }; } return true; }, IntPtr.Zero);
    return res;
  }
  public static IntPtr Top(string cls) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (found == IntPtr.Zero && Cls(h) == cls && IsWindowVisible(h)) found = h; return true; }, IntPtr.Zero);
    return found;
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


# --- Open the Paperwork folder ---------------------------------------------
Step "Explorer"
New-Item -ItemType Directory -Force $Out | Out-Null
$shell = New-Object -ComObject Shell.Application
# Close any Paperwork window already open, so we drive the one we open.
foreach ($w in @($shell.Windows())) { try { if ($w.Document.Folder.Self.Path -eq $Docs) { $w.Quit() } } catch {} }
Start-Sleep 1
Start-Process explorer.exe "`"$Docs`""
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 30 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 300
  foreach ($w in @($shell.Windows())) { try { if ($w.Document.Folder.Self.Path -eq $Docs) { $hwnd = [IntPtr]$w.HWND } } catch {} }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "Paperwork window not found" }
$win = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
Write-Host "window $hwnd elevated-shell=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
[W]::ShowWindow($hwnd, 3) | Out-Null
[W]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep 1
$sh = New-Object -ComObject WScript.Shell
$sh.SendKeys("^+2")          # Large icons
Start-Sleep 2
function Check($tag) {
  $fg = [W]::GetForegroundWindow(); $p = [System.Windows.Forms.Cursor]::Position
  Write-Host "$tag fg=$fg (explorer=$hwnd) cursor=$($p.X),$($p.Y)"
}
# Warm-up so thumbnails are cached.
foreach ($n in "Lease agreement", "Pride and Prejudice", "Receipt", "Library letter", "Garden plan") {
  ClickItem $win $n 250; Start-Sleep -Milliseconds 800; Check "warm $n"
}
Shot "warm"
$v = [Win]::ChildRect($hwnd, "SHELLDLL_DefView")
$ex = [int](($v[0] + $v[2]) / 2); $ey = [int]($v[3] - 150)
[W]::SetCursorPos($ex, $ey) | Out-Null; Click
$script:cx = $ex; $script:cy = $ey
Start-Sleep 2
Shot "00-setup"

# --- Record ------------------------------------------------------------------
Step "Record"
$ffexe = Get-ChildItem "C:\ProgramData\chocolatey\lib\ffmpeg\tools" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $ffexe) { $ffexe = (Get-Command ffmpeg).Source }
Write-Host "ffmpeg: $ffexe"
$file = "$Out\take.mkv"
$psi = New-Object System.Diagnostics.ProcessStartInfo $ffexe
$psi.Arguments = "-y -loglevel error -f gdigrab -framerate 30 -draw_mouse 1 -i desktop -t 45 -c:v libx264 -preset veryfast -crf 14 -pix_fmt yuv420p `"$file`""
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$ff = [System.Diagnostics.Process]::Start($psi)
Start-Sleep 2
$t0 = Get-Date
$marks = [ordered]@{}
function Mark($n) { $marks[$n] = [math]::Round(((Get-Date) - $t0).TotalSeconds + 2, 2) }
function QLOpen { [Win]::Top("EzReaderQuickLook") -ne [IntPtr]::Zero }
function Peek($n) {
  ClickItem $win $n 700; Start-Sleep -Milliseconds 700
  Mark "space-$n"; [W]::Key(0x20)
  for ($i = 0; $i -lt 8 -and -not (QLOpen); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (QLOpen)) { Write-Host "first Space didn't stick for $n, pressing again"; [W]::Key(0x20); for ($i = 0; $i -lt 10 -and -not (QLOpen); $i++) { Start-Sleep -Milliseconds 100 } }
  Mark "open-$n"; Write-Host "quick look open for ${n}: $(QLOpen)"
}
function Unpeek { Start-Sleep -Milliseconds 200; [W]::Key(0x20); Start-Sleep -Milliseconds 300; if (QLOpen) { [W]::Key(0x1B) }; Start-Sleep -Milliseconds 600 }

# Scene 2: thumbnails, click through the folder slowly.
Mark "s2-start"
ClickItem $win "Lease agreement" 1000;     Start-Sleep -Milliseconds 900; Check "lease"
ClickItem $win "Pride and Prejudice" 800;  Start-Sleep -Milliseconds 900
ClickItem $win "Receipt" 700;              Start-Sleep -Milliseconds 900
Shot "01-thumbs"
# Scene 3: Space on a few files.
Mark "s3-start"
Peek "Garden plan"; Start-Sleep -Milliseconds 1300; Shot "02-quicklook"
[W]::Key(0x28); Start-Sleep -Milliseconds 900; [W]::Key(0x28); Start-Sleep -Milliseconds 1000
Mark "close-garden"; Unpeek
Peek "Lease agreement"; Start-Sleep -Milliseconds 1800; Mark "close-lease"; Unpeek
Peek "Pride and Prejudice"; Start-Sleep -Milliseconds 1800; Mark "close-pp"; Unpeek
Mark "end"
Start-Sleep 1

$ff.StandardInput.Write("q"); $ff.StandardInput.Close()
if (-not $ff.WaitForExit(15000)) { $ff.Kill() }
$marks | ConvertTo-Json | Set-Content "$Out\marks.json"
Get-Content "$Out\marks.json" | Out-Host
Get-ChildItem $Out | Format-Table Name, Length | Out-Host
