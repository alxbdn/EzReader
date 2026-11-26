use crate::{layout, pdf, viewer};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, COLORREF, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, RECT, SIZE, WPARAM,
};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, GetMonitorInfoW,
    GetTextExtentPoint32W, InvalidateRect, LineTo, MonitorFromWindow, MoveToEx, RoundRect, SelectObject, SetBkMode,
    SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT,
    DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, HDC, HFONT, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::System::Threading::{AttachThreadInput, CreateMutexW, GetCurrentThreadId};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, SetFocus, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEINPUT, VIRTUAL_KEY, VK_CONTROL, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT,
    VK_PRIOR, VK_RETURN, VK_RIGHT, VK_RWIN, VK_SHIFT, VK_SPACE, VK_UP,
};
use windows::Win32::UI::Shell::{
    ExtractIconExW, IFolderView2, IShellBrowser, IShellWindows, IWebBrowser2, SID_STopLevelBrowser, ShellWindows,
    SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW, DrawIconEx,
    FindWindowExW, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetParent, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsWindow, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW,
    SendMessageW, SetCursor, SetForegroundWindow, SetWindowLongPtrW, SetWindowsHookExW, ShowWindow, TranslateMessage,
    UnhookWindowsHookEx, CREATESTRUCTW, CS_DROPSHADOW, DI_NORMAL, GUITHREADINFO, GWLP_USERDATA, HCURSOR, HC_ACTION,
    HICON, HTCAPTION, HTCLIENT, HWND_MESSAGE, IDC_ARROW, IDC_HAND, KBDLLHOOKSTRUCT, MSG, SW_SHOW, WA_INACTIVE,
    WH_KEYBOARD_LL, WINDOW_EX_STYLE, WM_ACTIVATE, WM_APP, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_PAINT, WM_SETCURSOR,
    WM_SYSKEYDOWN, WNDCLASSW, WS_CLIPCHILDREN, WS_EX_TOPMOST, WS_POPUP,
};

const HOST_CLASS: PCWSTR = w!("EzReaderQuickLookHost");
const WINDOW_CLASS: PCWSTR = w!("EzReaderQuickLook");
const WM_QUICK_LOOK: u32 = WM_APP + 40;
const REPLAYED: usize = 0x455A_514C;

static HOST: AtomicIsize = AtomicIsize::new(0);
static OPEN: AtomicIsize = AtomicIsize::new(0);
static HELD: AtomicBool = AtomicBool::new(false);
static SPACE_DOWN: AtomicBool = AtomicBool::new(false);
static SINGLE: AtomicBool = AtomicBool::new(false);

pub fn run(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "--stop") {
        stop();
        return 0;
    }
    if let Some(i) = args.iter().position(|a| a == "--preview") {
        return preview_one(args.get(i + 1).map(PathBuf::from));
    }
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _mutex = CreateMutexW(None, true, w!("Local\\EzReaderQuickLook"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return 0;
        }
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        register_classes();
        let Ok(host) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            HOST_CLASS,
            PCWSTR::null(),
            Default::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(crate::module()),
            None,
        ) else {
            return 1;
        };
        HOST.store(host.0 as isize, Ordering::SeqCst);
        std::thread::spawn(watch_keyboard);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    0
}

fn preview_one(path: Option<PathBuf>) -> i32 {
    let Some(path) = path.filter(|p| p.is_file()) else {
        return 2;
    };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        register_classes();
        SINGLE.store(true, Ordering::SeqCst);
        show(&path, windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow());
        if OPEN.load(Ordering::SeqCst) == 0 {
            return 1;
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    0
}

pub fn stop() {
    unsafe {
        if let Ok(host) = FindWindowExW(Some(HWND_MESSAGE), None, HOST_CLASS, PCWSTR::null()) {
            let _ = PostMessageW(Some(host), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

fn register_classes() {
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() };
    let host = WNDCLASSW {
        lpfnWndProc: Some(host_proc),
        hInstance: crate::module(),
        lpszClassName: HOST_CLASS,
        ..Default::default()
    };
    let window = WNDCLASSW {
        style: CS_DROPSHADOW,
        lpfnWndProc: Some(window_proc),
        hInstance: crate::module(),
        lpszClassName: WINDOW_CLASS,
        hCursor: cursor,
        ..Default::default()
    };
    unsafe {
        RegisterClassW(&host);
        RegisterClassW(&window);
    }
}

fn watch_keyboard() {
    unsafe {
        let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(crate::module()), 0) else {
            return;
        };
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            DispatchMessageW(&message);
        }
        let _ = UnhookWindowsHookEx(hook);
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if key.vkCode == VK_SPACE.0 as u32 && key.dwExtraInfo != REPLAYED {
            let message = wparam.0 as u32;
            if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                if HELD.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                let repeat = SPACE_DOWN.swap(true, Ordering::SeqCst);
                if !repeat && !modifiers_down() {
                    if let Some(explorer) = explorer_with_file_list_focused() {
                        HELD.store(true, Ordering::SeqCst);
                        let host = HWND(HOST.load(Ordering::SeqCst) as *mut _);
                        let _ =
                            unsafe { PostMessageW(Some(host), WM_QUICK_LOOK, WPARAM(explorer.0 as usize), LPARAM(0)) };
                        return LRESULT(1);
                    }
                }
            } else {
                SPACE_DOWN.store(false, Ordering::SeqCst);
                if HELD.swap(false, Ordering::SeqCst) {
                    return LRESULT(1);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn modifiers_down() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|k| unsafe { GetAsyncKeyState(k.0 as i32) } as u16 & 0x8000 != 0)
}

fn class_of(window: HWND) -> String {
    let mut buffer = [0u16; 64];
    let len = unsafe { GetClassNameW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

fn explorer_with_file_list_focused() -> Option<HWND> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() || !matches!(class_of(foreground).as_str(), "CabinetWClass" | "ExploreWClass") {
        return None;
    }
    let thread = unsafe { GetWindowThreadProcessId(foreground, None) };
    let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
    let focus = info.hwndFocus;
    if focus.is_invalid() || class_of(focus) != "DirectUIHWND" {
        return None;
    }
    let parent = unsafe { GetParent(focus) }.ok()?;
    (class_of(parent) == "SHELLDLL_DefView").then_some(foreground)
}

fn replay_space() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VK_SPACE, dwFlags: flags, dwExtraInfo: REPLAYED, ..Default::default() },
        },
    };
    let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

fn selected_file(explorer: HWND) -> Option<PathBuf> {
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
        let active_tab = FindWindowExW(Some(explorer), None, w!("ShellTabWindowClass"), PCWSTR::null()).ok();
        for i in 0..windows.Count().ok()? {
            let Ok(item) = windows.Item(&VARIANT::from(i)) else { continue };
            let Ok(browser) = item.cast::<IWebBrowser2>() else { continue };
            if browser.HWND().ok().map(|h| h.0) != Some(explorer.0 as isize) {
                continue;
            }
            let Ok(services) = browser.cast::<IServiceProvider>() else { continue };
            let Ok(shell) = services.QueryService::<IShellBrowser>(&SID_STopLevelBrowser) else { continue };
            if let (Some(tab), Ok(window)) = (active_tab, shell.GetWindow()) {
                if tab != window {
                    continue;
                }
            }
            let view = shell.QueryActiveShellView().ok()?;
            let folder = view.cast::<IFolderView2>().ok()?;
            let items = folder.GetSelection(false).ok()?;
            if items.GetCount().ok()? == 0 {
                return None;
            }
            let path = items.GetItemAt(0).ok()?.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
            let text = path.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
            return text.map(PathBuf::from);
        }
        None
    }
}

pub fn is_pdf(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

extern "system" fn host_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_QUICK_LOOK => {
            let explorer = HWND(wparam.0 as *mut _);
            if close_open_window() {
                return LRESULT(0);
            }
            match selected_file(explorer).filter(|p| is_pdf(p)) {
                Some(path) => show(&path, explorer),
                None => replay_space(),
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            close_open_window();
            let _ = unsafe { DestroyWindow(window) };
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

#[derive(Clone, Copy)]
struct Palette {
    surface: COLORREF,
    text: COLORREF,
    muted: COLORREF,
    muted_text: COLORREF,
    primary: COLORREF,
    primary_text: COLORREF,
    border: COLORREF,
    viewer: COLORREF,
    dot: COLORREF,
}

const fn hex(rgb: u32) -> COLORREF {
    COLORREF(((rgb >> 16) & 0xff) | (rgb & 0xff00) | ((rgb & 0xff) << 16))
}

const LIGHT: Palette = Palette {
    surface: hex(0xffffff),
    text: hex(0x09090b),
    muted: hex(0xf4f4f5),
    muted_text: hex(0x71717a),
    primary: hex(0x18181b),
    primary_text: hex(0xfafafa),
    border: hex(0xe4e4e7),
    viewer: hex(0xf4f4f5),
    dot: hex(0xd4d4d5),
};

const DARK: Palette = Palette {
    surface: hex(0x18181b),
    text: hex(0xfafafa),
    muted: hex(0x27272a),
    muted_text: hex(0xa1a1aa),
    primary: hex(0xfafafa),
    primary_text: hex(0x18181b),
    border: hex(0x27272a),
    viewer: hex(0x09090b),
    dot: hex(0x232326),
};

fn apps_use_light_theme() -> bool {
    let mut value = 1u32;
    let mut size = 4u32;
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    read.is_err() || value != 0
}

struct Words {
    open: &'static str,
    close: &'static str,
    pages: &'static str,
}

fn words() -> &'static Words {
    static EN: Words = Words { open: "Open in EzReader", close: "Close", pages: "Pages" };
    static FR: Words = Words { open: "Ouvrir dans EzReader", close: "Fermer", pages: "Pages" };
    if french() {
        &FR
    } else {
        &EN
    }
}

fn french() -> bool {
    let language = unsafe { GetUserDefaultUILanguage() };
    language & 0x3ff == 0x0c
}

pub fn describe(pages: usize, bytes: u64, french: bool) -> String {
    let (one, many, kb, mb, decimal) =
        if french { ("page", "pages", "Ko", "Mo", ',') } else { ("page", "pages", "KB", "MB", '.') };
    let count = format!("{pages} {}", if pages == 1 { one } else { many });
    let size = if bytes >= 1024 * 1024 {
        format!("{:.1} {mb}", bytes as f64 / (1024.0 * 1024.0)).replace('.', &decimal.to_string())
    } else {
        format!("{} {kb}", bytes.div_ceil(1024).max(1))
    };
    if pages == 0 {
        size
    } else {
        format!("{count} · {size}")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Control {
    Previous,
    Next,
    Open,
    Close,
}

struct QuickLook {
    path: PathBuf,
    name: String,
    details: String,
    explorer: HWND,
    viewer: HWND,
    pages: usize,
    page: usize,
    palette: Palette,
    scale: f32,
    controls: Vec<(Control, RECT)>,
    hover: Option<Control>,
    icon: Option<HICON>,
    armed: bool,
}

impl QuickLook {
    fn px(&self, v: f32) -> i32 {
        (v * self.scale).round() as i32
    }

    fn header(&self) -> i32 {
        self.px(52.0)
    }

    fn footer(&self) -> i32 {
        self.px(36.0)
    }

    fn control_at(&self, x: i32, y: i32) -> Option<Control> {
        self.controls.iter().find(|(_, r)| x >= r.left && x < r.right && y >= r.top && y < r.bottom).map(|(c, _)| *c)
    }
}

impl Drop for QuickLook {
    fn drop(&mut self) {
        if let Some(icon) = self.icon.take() {
            let _ = unsafe { DestroyIcon(icon) };
        }
    }
}

fn app_exe() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    ["ezreader-portable.exe", "EzReader.exe", "ezreader.exe"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file() && *p != me)
}

fn app_icon() -> Option<HICON> {
    let exe = app_exe()?;
    let wide: Vec<u16> = exe.as_os_str().encode_wide_null();
    let mut large = HICON::default();
    let found = unsafe { ExtractIconExW(PCWSTR(wide.as_ptr()), 0, Some(&mut large), None, 1) };
    (found > 0 && !large.is_invalid()).then_some(large)
}

trait EncodeWideNull {
    fn encode_wide_null(&self) -> Vec<u16>;
}

impl EncodeWideNull for std::ffi::OsStr {
    fn encode_wide_null(&self) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        self.encode_wide().chain(std::iter::once(0)).collect()
    }
}

fn close_open_window() -> bool {
    let open = HWND(OPEN.swap(0, Ordering::SeqCst) as *mut _);
    if !open.is_invalid() && unsafe { IsWindow(Some(open)) }.as_bool() {
        let _ = unsafe { DestroyWindow(open) };
        return true;
    }
    false
}

fn bring_to_front(window: HWND) -> bool {
    unsafe {
        if GetForegroundWindow() == window {
            return true;
        }
        let nudge = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dwExtraInfo: REPLAYED, ..Default::default() } },
        };
        SendInput(&[nudge], std::mem::size_of::<INPUT>() as i32);
        let _ = SetForegroundWindow(window);
        if GetForegroundWindow() == window {
            return true;
        }
        let foreground = GetForegroundWindow();
        let theirs = GetWindowThreadProcessId(foreground, None);
        let ours = GetCurrentThreadId();
        let attached = theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let _ = SetForegroundWindow(window);
        let _ = SetFocus(Some(window));
        if attached {
            let _ = AttachThreadInput(ours, theirs, false);
        }
        GetForegroundWindow() == window
    }
}

fn show(path: &Path, explorer: HWND) {
    close_open_window();
    let bytes = std::fs::read(path).unwrap_or_default();
    let document = pdf::open(&bytes).ok();
    let pages = document.as_ref().and_then(|d| d.PageCount().ok()).unwrap_or(0) as usize;
    let french = french();
    let palette = if apps_use_light_theme() { LIGHT } else { DARK };
    let state = Box::new(QuickLook {
        path: path.to_path_buf(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        details: describe(pages, bytes.len() as u64, french),
        explorer,
        viewer: HWND::default(),
        pages,
        page: 0,
        palette,
        scale: 1.0,
        controls: Vec::new(),
        hover: None,
        icon: app_icon(),
        armed: false,
    });

    let monitor = unsafe { MonitorFromWindow(explorer, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let _ = unsafe { GetMonitorInfoW(monitor, &mut info) };
    let work = info.rcWork;
    let r = layout::quick_look_rect((work.left, work.top, work.right, work.bottom));

    let raw = Box::into_raw(state);
    let title: Vec<u16> = std::ffi::OsStr::new(&unsafe { &*raw }.name).encode_wide_null();
    let created = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST,
            WINDOW_CLASS,
            PCWSTR(title.as_ptr()),
            WS_POPUP | WS_CLIPCHILDREN,
            r.0,
            r.1,
            r.2 - r.0,
            r.3 - r.1,
            None,
            None,
            Some(crate::module()),
            Some(raw as *const std::ffi::c_void),
        )
    };
    let Ok(window) = created else {
        drop(unsafe { Box::from_raw(raw) });
        return;
    };
    let state = unsafe { &mut *raw };
    state.scale = unsafe { GetDpiForWindow(window) }.max(96) as f32 / 96.0;
    let _ = unsafe {
        DwmSetWindowAttribute(
            window,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&DWMWCP_ROUND) as u32,
        )
    };
    let (width, height) = (r.2 - r.0, r.3 - r.1);
    let area = RECT { left: 0, top: state.header(), right: width, bottom: height - state.footer() };
    let style = viewer::Style {
        background: palette.viewer,
        text: palette.muted_text,
        dots: Some(palette.dot),
        fit_height: true,
        take_focus: false,
    };
    state.viewer = viewer::create(window, area, document, style).unwrap_or_default();
    unsafe {
        let _ = ShowWindow(window, SW_SHOW);
    }
    state.armed = bring_to_front(window);
    OPEN.store(window.0 as isize, Ordering::SeqCst);
}

fn close(window: HWND, state: &QuickLook) {
    if unsafe { IsWindow(Some(state.explorer)) }.as_bool() {
        let _ = unsafe { SetForegroundWindow(state.explorer) };
    }
    OPEN.store(0, Ordering::SeqCst);
    let _ = unsafe { DestroyWindow(window) };
}

fn open_in_app(window: HWND, state: &QuickLook) {
    if let Some(exe) = app_exe() {
        let _ = std::process::Command::new(exe).arg(&state.path).spawn();
    }
    OPEN.store(0, Ordering::SeqCst);
    let _ = unsafe { DestroyWindow(window) };
}

fn go_to(state: &QuickLook, page: usize) {
    if state.pages > 0 && !state.viewer.is_invalid() {
        let page = page.min(state.pages - 1);
        unsafe { SendMessageW(state.viewer, viewer::WM_VIEWER_GOTO, Some(WPARAM(page)), None) };
    }
}

struct Painter {
    dc: HDC,
}

impl Painter {
    fn fill(&self, r: RECT, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            FillRect(self.dc, &r, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
    }

    fn rounded(&self, r: RECT, radius: i32, fill: COLORREF, edge: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(fill);
            let pen = CreatePen(PS_SOLID, 1, edge);
            let old_brush = SelectObject(self.dc, HGDIOBJ(brush.0));
            let old_pen = SelectObject(self.dc, HGDIOBJ(pen.0));
            let _ = RoundRect(self.dc, r.left, r.top, r.right, r.bottom, radius * 2, radius * 2);
            SelectObject(self.dc, old_brush);
            SelectObject(self.dc, old_pen);
            let _ = DeleteObject(HGDIOBJ(brush.0));
            let _ = DeleteObject(HGDIOBJ(pen.0));
        }
    }

    fn lines(&self, points: &[(i32, i32)], width: i32, color: COLORREF) {
        unsafe {
            let pen = CreatePen(PS_SOLID, width, color);
            let old = SelectObject(self.dc, HGDIOBJ(pen.0));
            if let Some(&(x, y)) = points.first() {
                let _ = MoveToEx(self.dc, x, y, None);
                for &(x, y) in &points[1..] {
                    let _ = LineTo(self.dc, x, y);
                }
            }
            SelectObject(self.dc, old);
            let _ = DeleteObject(HGDIOBJ(pen.0));
        }
    }

    fn text(&self, text: &str, r: RECT, font: HFONT, color: COLORREF, center: bool) {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        let mut r = r;
        unsafe {
            let old = SelectObject(self.dc, HGDIOBJ(font.0));
            SetTextColor(self.dc, color);
            let align = if center { DT_CENTER } else { DT_LEFT };
            DrawTextW(self.dc, &mut wide, &mut r, align | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
            SelectObject(self.dc, old);
        }
    }

    fn width(&self, text: &str, font: HFONT) -> i32 {
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut size = SIZE::default();
        unsafe {
            let old = SelectObject(self.dc, HGDIOBJ(font.0));
            let _ = GetTextExtentPoint32W(self.dc, &wide, &mut size);
            SelectObject(self.dc, old);
        }
        size.cx
    }
}

fn font(size: f32, weight: i32) -> HFONT {
    unsafe {
        CreateFontW(
            -(size.round() as i32),
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            FF_DONTCARE.0 as u32,
            w!("Segoe UI Variable Text"),
        )
    }
}

fn paint(window: HWND, state: &mut QuickLook) {
    let mut ps = PAINTSTRUCT::default();
    let dc = unsafe { BeginPaint(window, &mut ps) };
    let p = Painter { dc };
    let c = state.palette;
    let mut client = RECT::default();
    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(window, &mut client) };
    let (w, h) = (client.right, client.bottom);
    let (header, footer) = (state.header(), state.footer());
    let s = |v: f32| state.px(v);
    let words = words();
    let body = font(13.0 * state.scale, 400);
    let medium = font(13.0 * state.scale, 500);
    let bold = font(13.0 * state.scale, 600);
    let small = font(12.0 * state.scale, 400);
    let key = font(11.0 * state.scale, 500);
    unsafe { SetBkMode(dc, TRANSPARENT) };
    let mut controls = Vec::new();

    p.fill(RECT { left: 0, top: 0, right: w, bottom: header }, c.surface);
    p.fill(RECT { left: 0, top: header - 1, right: w, bottom: header }, c.border);
    p.fill(RECT { left: 0, top: h - footer, right: w, bottom: h }, c.surface);
    p.fill(RECT { left: 0, top: h - footer, right: w, bottom: h - footer + 1 }, c.border);

    let mid = header / 2;
    let mut x = s(16.0);
    if let Some(icon) = state.icon {
        let size = s(18.0);
        let _ = unsafe { DrawIconEx(dc, x, mid - size / 2, icon, size, size, 0, None, DI_NORMAL) };
        x += size + s(10.0);
    }

    let close = RECT { left: w - s(42.0), top: mid - s(16.0), right: w - s(10.0), bottom: mid + s(16.0) };
    if state.hover == Some(Control::Close) {
        p.rounded(close, s(6.0), c.muted, c.muted);
    }
    let (cx, cy, d) = ((close.left + close.right) / 2, (close.top + close.bottom) / 2, s(5.0));
    let stroke = s(1.5).max(1);
    p.lines(&[(cx - d, cy - d), (cx + d + 1, cy + d + 1)], stroke, c.muted_text);
    p.lines(&[(cx + d, cy - d), (cx - d - 1, cy + d + 1)], stroke, c.muted_text);
    controls.push((Control::Close, close));

    let open_width = p.width(words.open, medium) + s(24.0);
    let open = RECT {
        left: close.left - s(8.0) - open_width,
        top: mid - s(16.0),
        right: close.left - s(8.0),
        bottom: mid + s(16.0),
    };
    let fill = if state.hover == Some(Control::Open) { blend(c.primary, c.surface, 0.12) } else { c.primary };
    p.rounded(open, s(6.0), fill, fill);
    p.text(words.open, open, medium, c.primary_text, true);
    controls.push((Control::Open, open));

    let mut name_right = open.left - s(12.0);
    if state.pages > 0 {
        let label = format!("{} / {}", state.page + 1, state.pages);
        let label_width = p.width(&format!("{} / {}", state.pages, state.pages), body) + s(8.0);
        let arrow = s(28.0);
        let pill = RECT {
            left: open.left - s(10.0) - label_width - 2 * arrow,
            top: mid - s(14.0),
            right: open.left - s(10.0),
            bottom: mid + s(14.0),
        };
        p.rounded(pill, s(14.0), c.muted, c.muted);
        let up = RECT { left: pill.left, top: pill.top, right: pill.left + arrow, bottom: pill.bottom };
        let down = RECT { left: pill.right - arrow, top: pill.top, right: pill.right, bottom: pill.bottom };
        let text = RECT { left: up.right, top: pill.top, right: down.left, bottom: pill.bottom };
        p.text(&label, text, body, c.text, true);
        let chevron = |r: RECT, up: bool, hover: bool| {
            let (x, y, d) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2, s(4.0));
            let color = if hover { c.text } else { c.muted_text };
            if up {
                p.lines(&[(x - d, y + d / 2), (x, y - d / 2), (x + d + 1, y + d / 2 + 1)], stroke, color);
            } else {
                p.lines(&[(x - d, y - d / 2), (x, y + d / 2), (x + d + 1, y - d / 2 - 1)], stroke, color);
            }
        };
        chevron(up, true, state.hover == Some(Control::Previous));
        chevron(down, false, state.hover == Some(Control::Next));
        controls.push((Control::Previous, up));
        controls.push((Control::Next, down));
        name_right = pill.left - s(12.0);
    }

    let name_width = p.width(&state.name, bold).min((name_right - x).max(0));
    p.text(&state.name, RECT { left: x, top: 0, right: x + name_width, bottom: header }, bold, c.text, false);
    let details_left = x + name_width + s(8.0);
    if details_left < name_right {
        p.text(
            &format!("· {}", state.details),
            RECT { left: details_left, top: 0, right: name_right, bottom: header },
            small,
            c.muted_text,
            false,
        );
    }

    let hints: [(&[&str], &str); 3] = [(&["Space"], words.close), (&["↑", "↓"], words.pages), (&["Enter"], words.open)];
    let gap = s(16.0);
    let key_pad = s(6.0);
    let key_height = s(20.0);
    let measure = |keys: &[&str], label: &str| {
        keys.iter().map(|k| p.width(k, key) + 2 * key_pad + s(4.0)).sum::<i32>() + s(2.0) + p.width(label, small)
    };
    let total: i32 = hints.iter().map(|(k, l)| measure(k, l)).sum::<i32>() + gap * (hints.len() as i32 - 1);
    let mut hx = (w - total) / 2;
    let fy = h - footer / 2;
    for (keys, label) in hints {
        for k in keys {
            let kw = p.width(k, key) + 2 * key_pad;
            let r = RECT { left: hx, top: fy - key_height / 2, right: hx + kw, bottom: fy + key_height / 2 };
            p.rounded(r, s(4.0), c.muted, c.border);
            p.text(k, r, key, c.text, true);
            hx += kw + s(4.0);
        }
        hx += s(2.0);
        let lw = p.width(label, small);
        p.text(label, RECT { left: hx, top: h - footer, right: hx + lw + 1, bottom: h }, small, c.muted_text, false);
        hx += lw + gap;
    }

    p.lines(&[(0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1), (0, 0)], 1, c.border);

    for f in [body, medium, bold, small, key] {
        let _ = unsafe { DeleteObject(HGDIOBJ(f.0)) };
    }
    state.controls = controls;
    let _ = unsafe { EndPaint(window, &ps) };
}

fn blend(a: COLORREF, b: COLORREF, t: f32) -> COLORREF {
    let mix = |shift: u32| {
        let x = ((a.0 >> shift) & 0xff) as f32;
        let y = ((b.0 >> shift) & 0xff) as f32;
        ((x + (y - x) * t).round() as u32) << shift
    };
    COLORREF(mix(0) | mix(8) | mix(16))
}

fn point(lparam: LPARAM) -> (i32, i32) {
    ((lparam.0 & 0xffff) as u16 as i16 as i32, ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32)
}

extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(window, GWLP_USERDATA, create.lpCreateParams as isize);
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let state = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut QuickLook;
        if state.is_null() {
            return DefWindowProcW(window, message, wparam, lparam);
        }
        if message == WM_NCDESTROY {
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            drop(Box::from_raw(state));
            if SINGLE.load(Ordering::SeqCst) {
                PostQuitMessage(0);
            }
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let state = &mut *state;
        match message {
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                paint(window, state);
                LRESULT(0)
            }
            WM_KEYDOWN => {
                let key = VIRTUAL_KEY(wparam.0 as u16);
                match key {
                    VK_SPACE | VK_ESCAPE => close(window, state),
                    VK_RETURN => open_in_app(window, state),
                    VK_UP | VK_LEFT | VK_PRIOR => go_to(state, state.page.saturating_sub(1)),
                    VK_DOWN | VK_RIGHT | VK_NEXT => go_to(state, state.page + 1),
                    VK_HOME => go_to(state, 0),
                    VK_END => go_to(state, usize::MAX),
                    _ => {}
                }
                LRESULT(0)
            }
            WM_MOUSEWHEEL => {
                if !state.viewer.is_invalid() {
                    SendMessageW(state.viewer, message, Some(wparam), Some(lparam));
                }
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let (x, y) = point(lparam);
                let hover = state.control_at(x, y);
                if hover != state.hover {
                    state.hover = hover;
                    let _ = InvalidateRect(Some(window), None, false);
                }
                LRESULT(0)
            }
            WM_SETCURSOR => {
                let cursor: HCURSOR = if state.hover.is_some() {
                    LoadCursorW(None, IDC_HAND).unwrap_or_default()
                } else {
                    LoadCursorW(None, IDC_ARROW).unwrap_or_default()
                };
                SetCursor(Some(cursor));
                LRESULT(1)
            }
            WM_LBUTTONUP => {
                let (x, y) = point(lparam);
                match state.control_at(x, y) {
                    Some(Control::Close) => close(window, state),
                    Some(Control::Open) => open_in_app(window, state),
                    Some(Control::Previous) => go_to(state, state.page.saturating_sub(1)),
                    Some(Control::Next) => go_to(state, state.page + 1),
                    None => {}
                }
                LRESULT(0)
            }
            WM_NCHITTEST => {
                let hit = DefWindowProcW(window, message, wparam, lparam);
                if hit.0 as u32 != HTCLIENT {
                    return hit;
                }
                let (sx, sy) = point(lparam);
                let mut r = RECT::default();
                let _ = GetWindowRect(window, &mut r);
                let (x, y) = (sx - r.left, sy - r.top);
                if y < state.header() && state.control_at(x, y).is_none() {
                    LRESULT(HTCAPTION as isize)
                } else {
                    hit
                }
            }
            viewer::WM_VIEWER_PAGE_CHANGED => {
                state.page = wparam.0;
                let _ = InvalidateRect(Some(window), None, false);
                LRESULT(0)
            }
            WM_ACTIVATE => {
                let current = OPEN.load(Ordering::SeqCst) == window.0 as isize;
                if (wparam.0 & 0xffff) as u32 != WA_INACTIVE {
                    if current && GetForegroundWindow() == window {
                        state.armed = true;
                    }
                } else if state.armed && current {
                    let _ = PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
                LRESULT(0)
            }
            WM_CLOSE => {
                if OPEN.load(Ordering::SeqCst) == window.0 as isize {
                    OPEN.store(0, Ordering::SeqCst);
                }
                let _ = DestroyWindow(window);
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_read_naturally() {
        assert_eq!(describe(24, 2_516_582, false), "24 pages · 2.4 MB");
        assert_eq!(describe(1, 2_048, false), "1 page · 2 KB");
        assert_eq!(describe(3, 1_572_864, true), "3 pages · 1,5 Mo");
        assert_eq!(describe(0, 10, false), "1 KB");
    }

    #[test]
    fn only_pdfs_get_a_quick_look() {
        assert!(is_pdf(Path::new(r"C:\Docs\Report.PDF")));
        assert!(!is_pdf(Path::new(r"C:\Docs\photo.png")));
        assert!(!is_pdf(Path::new(r"C:\Docs\pdf")));
    }

    #[test]
    fn colors_are_in_windows_order() {
        assert_eq!(hex(0xE53935).0, 0x3539E5);
    }
}
