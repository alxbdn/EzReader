use crate::{layout, pdf};
use std::collections::HashMap;
use windows::core::{w, Result, PCWSTR};
use windows::Data::Pdf::PdfDocument;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, FillRect, FrameRect, InvalidateRect, SelectObject, SetBkMode, SetTextColor, DT_CENTER,
    DT_NOPREFIX, DT_WORDBREAK, HBITMAP, HDC, HGDIOBJ, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows::Win32::UI::Controls::SetScrollInfo;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SetFocus, VK_DOWN, VK_END, VK_HOME, VK_NEXT, VK_PRIOR, VK_SPACE, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetParent, GetScrollInfo, GetWindowLongPtrW, LoadCursorW,
    PostMessageW, RegisterClassW, SetWindowLongPtrW, UnregisterClassW, CREATESTRUCTW, GWLP_USERDATA, IDC_ARROW,
    SB_BOTTOM, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP, SB_THUMBTRACK, SB_TOP, SB_VERT, SCROLLINFO, SIF_ALL,
    SIF_PAGE, SIF_POS, SIF_RANGE, SIF_TRACKPOS, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_ERASEBKGND, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_MOUSEWHEEL, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SIZE, WM_VSCROLL, WNDCLASSW, WS_CHILD,
    WS_CLIPCHILDREN, WS_VISIBLE, WS_VSCROLL,
};

const CLASS_NAME: PCWSTR = w!("EzReaderPdfPages");
const LINE: i32 = 48;

pub const WM_VIEWER_COLORS: u32 = WM_APP + 1;
pub const WM_VIEWER_GOTO: u32 = WM_APP + 2;
pub const WM_VIEWER_PAGE: u32 = WM_APP + 3;
pub const WM_VIEWER_PAGE_COUNT: u32 = WM_APP + 4;
pub const WM_VIEWER_PAGE_CHANGED: u32 = WM_APP + 5;

static CLASS_REGISTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn register_class() {
    use std::sync::atomic::Ordering;
    if CLASS_REGISTERED.load(Ordering::SeqCst) {
        return;
    }
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: crate::module(),
        lpszClassName: CLASS_NAME,
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() },
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } != 0 {
        CLASS_REGISTERED.store(true, Ordering::SeqCst);
    }
}

pub fn unregister_class() {
    use std::sync::atomic::Ordering;
    if CLASS_REGISTERED.swap(false, Ordering::SeqCst) {
        let _ = unsafe { UnregisterClassW(CLASS_NAME, Some(crate::module())) };
    }
}

#[derive(Clone, Copy)]
pub struct Style {
    pub background: COLORREF,
    pub text: COLORREF,
    pub dots: Option<COLORREF>,
    pub fit_height: bool,
    pub take_focus: bool,
}

pub fn create(parent: HWND, rect: RECT, document: Option<PdfDocument>, style: Style) -> Result<HWND> {
    register_class();
    let raw = Box::into_raw(Box::new(Viewer::new(document, style)));
    let created = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_CLIPCHILDREN | WINDOW_STYLE(0),
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            Some(parent),
            None,
            Some(crate::module()),
            Some(raw as *const std::ffi::c_void),
        )
    };
    if created.is_err() && unsafe { (*raw).window.is_invalid() } {
        drop(unsafe { Box::from_raw(raw) });
    }
    created
}

fn paint_dots(dc: HDC, w: i32, h: i32, color: COLORREF, window: HWND) {
    let scale = unsafe { GetDpiForWindow(window) }.max(96) as f32 / 96.0;
    let step = (22.0 * scale).round() as i32;
    let size = scale.round().max(1.0) as i32;
    let brush = unsafe { CreateSolidBrush(color) };
    let mut y = step / 2;
    while y < h {
        let mut x = step / 2;
        while x < w {
            unsafe { FillRect(dc, &RECT { left: x, top: y, right: x + size, bottom: y + size }, brush) };
            x += step;
        }
        y += step;
    }
    let _ = unsafe { DeleteObject(HGDIOBJ(brush.0)) };
}

struct Drawn {
    bitmap: HBITMAP,
}

impl Drop for Drawn {
    fn drop(&mut self) {
        let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) };
    }
}

struct Viewer {
    window: HWND,
    document: Option<PdfDocument>,
    sizes: Vec<(f32, f32)>,
    slots: Vec<layout::Slot>,
    total: i32,
    width: i32,
    height: i32,
    scroll: i32,
    drawn: HashMap<usize, Drawn>,
    style: Style,
    reported: usize,
}

impl Viewer {
    fn new(document: Option<PdfDocument>, style: Style) -> Self {
        let sizes = document
            .as_ref()
            .and_then(|d| {
                let count = d.PageCount().ok()?;
                (0..count).map(|i| d.GetPage(i).and_then(|p| pdf::page_size(&p)).ok()).collect::<Option<Vec<_>>>()
            })
            .unwrap_or_default();
        let document = if sizes.is_empty() { None } else { document };
        Viewer {
            window: HWND::default(),
            document,
            sizes,
            slots: Vec::new(),
            total: 0,
            width: 0,
            height: 0,
            scroll: 0,
            drawn: HashMap::new(),
            style,
            reported: usize::MAX,
        }
    }

    fn resize(&mut self, width: i32, height: i32) {
        if width != self.width || (self.style.fit_height && height != self.height) {
            self.drawn.clear();
            let max_width = match (self.style.fit_height, self.sizes.first()) {
                (true, Some(&first)) => layout::width_to_fit_height(first, height),
                _ => layout::MAX_PAGE_WIDTH,
            };
            let (slots, total) = layout::column(&self.sizes, width, max_width);
            let ratio = if self.total > 0 { self.scroll as f64 / self.total as f64 } else { 0.0 };
            self.slots = slots;
            self.total = total;
            self.scroll = (ratio * total as f64) as i32;
        }
        self.width = width;
        self.height = height;
        self.scroll_to(self.scroll);
    }

    fn scroll_to(&mut self, scroll: i32) {
        self.scroll = layout::clamp_scroll(scroll, self.total, self.height);
        let info = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
            nMin: 0,
            nMax: (self.total - 1).max(0),
            nPage: self.height.max(0) as u32,
            nPos: self.scroll,
            nTrackPos: 0,
        };
        unsafe {
            SetScrollInfo(self.window, SB_VERT, &info, true);
            let _ = InvalidateRect(Some(self.window), None, false);
        }
        let page = self.current_page();
        if page != self.reported {
            self.reported = page;
            if let Ok(parent) = unsafe { GetParent(self.window) } {
                let _ = unsafe { PostMessageW(Some(parent), WM_VIEWER_PAGE_CHANGED, WPARAM(page), LPARAM(0)) };
            }
        }
    }

    fn current_page(&self) -> usize {
        layout::page_at(&self.slots, self.scroll, self.height)
    }

    fn page_bitmap(&mut self, index: usize) -> Option<HBITMAP> {
        if let Some(d) = self.drawn.get(&index) {
            return Some(d.bitmap);
        }
        let slot = self.slots[index];
        let page = self.document.as_ref()?.GetPage(index as u32).ok()?;
        let picture = pdf::render(&page, slot.width as u32, slot.height as u32).ok()?;
        let bitmap = pdf::to_bitmap(&picture).ok()?;
        self.drawn.insert(index, Drawn { bitmap });
        Some(bitmap)
    }

    fn paint(&mut self, target: HDC) {
        let (w, h) = (self.width.max(1), self.height.max(1));
        unsafe {
            let buffer_dc = CreateCompatibleDC(Some(target));
            let buffer = CreateCompatibleBitmap(target, w, h);
            let old = SelectObject(buffer_dc, HGDIOBJ(buffer.0));
            let background = CreateSolidBrush(self.style.background);
            FillRect(buffer_dc, &RECT { left: 0, top: 0, right: w, bottom: h }, background);
            let _ = DeleteObject(HGDIOBJ(background.0));
            if let Some(dot) = self.style.dots {
                paint_dots(buffer_dc, w, h, dot, self.window);
            }

            if self.document.is_none() {
                self.paint_message(buffer_dc, w, h);
            } else {
                let range = layout::visible(&self.slots, self.scroll, h);
                let keep = range.start.saturating_sub(2)..range.end + 2;
                self.drawn.retain(|i, _| keep.contains(i));
                let page_dc = CreateCompatibleDC(Some(buffer_dc));
                let border = CreateSolidBrush(COLORREF(0x00c8c8c8));
                for index in range {
                    let slot = self.slots[index];
                    let top = slot.top - self.scroll;
                    let frame = RECT {
                        left: slot.left - 1,
                        top: top - 1,
                        right: slot.left + slot.width + 1,
                        bottom: top + slot.height + 1,
                    };
                    FrameRect(buffer_dc, &frame, border);
                    if let Some(bitmap) = self.page_bitmap(index) {
                        let previous = SelectObject(page_dc, HGDIOBJ(bitmap.0));
                        let _ =
                            BitBlt(buffer_dc, slot.left, top, slot.width, slot.height, Some(page_dc), 0, 0, SRCCOPY);
                        SelectObject(page_dc, previous);
                    }
                }
                let _ = DeleteObject(HGDIOBJ(border.0));
                let _ = DeleteDC(page_dc);
            }

            let _ = BitBlt(target, 0, 0, w, h, Some(buffer_dc), 0, 0, SRCCOPY);
            SelectObject(buffer_dc, old);
            let _ = DeleteObject(HGDIOBJ(buffer.0));
            let _ = DeleteDC(buffer_dc);
        }
    }

    fn paint_message(&self, dc: HDC, w: i32, h: i32) {
        let french = unsafe { GetUserDefaultUILanguage() } & 0x3ff == 0x0c;
        let text = if french {
            "EzReader ne peut pas afficher l’aperçu de ce PDF (protégé par mot de passe ou abîmé)."
        } else {
            "EzReader can’t preview this PDF (it is password-protected or damaged)."
        };
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        let mut rect = RECT { left: 24, top: h / 2 - 40, right: w - 24, bottom: h };
        unsafe {
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, self.style.text);
            DrawTextW(dc, &mut wide, &mut rect, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
        }
    }
}

fn loword(v: usize) -> u32 {
    (v & 0xffff) as u32
}

extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            let viewer = create.lpCreateParams as *mut Viewer;
            (*viewer).window = window;
            SetWindowLongPtrW(window, GWLP_USERDATA, viewer as isize);
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let viewer = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut Viewer;
        if viewer.is_null() {
            return DefWindowProcW(window, message, wparam, lparam);
        }
        if message == WM_NCDESTROY {
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            drop(Box::from_raw(viewer));
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let viewer = &mut *viewer;
        match message {
            WM_SIZE => {
                let mut r = RECT::default();
                let _ = GetClientRect(window, &mut r);
                viewer.resize(r.right - r.left, r.bottom - r.top);
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(window, &mut ps);
                viewer.paint(dc);
                let _ = EndPaint(window, &ps);
                LRESULT(0)
            }
            WM_VSCROLL => {
                let page = viewer.height - LINE;
                let target = match loword(wparam.0) as i32 {
                    x if x == SB_LINEUP.0 => viewer.scroll - LINE,
                    x if x == SB_LINEDOWN.0 => viewer.scroll + LINE,
                    x if x == SB_PAGEUP.0 => viewer.scroll - page,
                    x if x == SB_PAGEDOWN.0 => viewer.scroll + page,
                    x if x == SB_TOP.0 => 0,
                    x if x == SB_BOTTOM.0 => viewer.total,
                    x if x == SB_THUMBTRACK.0 => {
                        let mut info = SCROLLINFO {
                            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
                            fMask: SIF_TRACKPOS | SIF_ALL,
                            ..Default::default()
                        };
                        let _ = GetScrollInfo(window, SB_VERT, &mut info);
                        info.nTrackPos
                    }
                    _ => viewer.scroll,
                };
                viewer.scroll_to(target);
                LRESULT(0)
            }
            WM_MOUSEWHEEL => {
                let delta = ((wparam.0 >> 16) & 0xffff) as u16 as i16 as i32;
                viewer.scroll_to(viewer.scroll - delta * 3 * LINE / 120);
                LRESULT(0)
            }
            WM_KEYDOWN => {
                let page = viewer.height - LINE;
                let key = wparam.0 as u16;
                let target = match key {
                    k if k == VK_UP.0 => Some(viewer.scroll - LINE),
                    k if k == VK_DOWN.0 => Some(viewer.scroll + LINE),
                    k if k == VK_PRIOR.0 => Some(viewer.scroll - page),
                    k if k == VK_NEXT.0 || k == VK_SPACE.0 => Some(viewer.scroll + page),
                    k if k == VK_HOME.0 => Some(0),
                    k if k == VK_END.0 => Some(viewer.total),
                    _ => None,
                };
                match target {
                    Some(t) => {
                        viewer.scroll_to(t);
                        LRESULT(0)
                    }
                    None => DefWindowProcW(window, message, wparam, lparam),
                }
            }
            WM_LBUTTONDOWN => {
                if viewer.style.take_focus {
                    let _ = SetFocus(Some(window));
                }
                LRESULT(0)
            }
            WM_VIEWER_COLORS => {
                viewer.style.background = COLORREF(wparam.0 as u32);
                viewer.style.text = COLORREF(lparam.0 as u32);
                let _ = InvalidateRect(Some(window), None, false);
                LRESULT(0)
            }
            WM_VIEWER_GOTO => {
                let index = wparam.0.min(viewer.slots.len().saturating_sub(1));
                if let Some(slot) = viewer.slots.get(index) {
                    viewer.scroll_to(slot.top - layout::MARGIN);
                }
                LRESULT(0)
            }
            WM_VIEWER_PAGE => LRESULT(viewer.current_page() as isize),
            WM_VIEWER_PAGE_COUNT => LRESULT(viewer.sizes.len() as isize),
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}
