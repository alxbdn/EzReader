use crate::{layout, pdf, Alive};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use windows::core::{implement, w, Interface, Ref, Result, GUID, PCWSTR};
use windows::Data::Pdf::PdfDocument;
use windows::Win32::Foundation::{
    COLORREF, E_FAIL, E_INVALIDARG, E_POINTER, E_UNEXPECTED, HWND, LPARAM, LRESULT, RECT, S_FALSE, WPARAM,
};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, FillRect, FrameRect, GetSysColor, InvalidateRect, SelectObject, SetBkMode, SetTextColor,
    COLOR_WINDOW, COLOR_WINDOWTEXT, DT_CENTER, DT_NOPREFIX, DT_WORDBREAK, HBITMAP, HDC, HGDIOBJ, PAINTSTRUCT, SRCCOPY,
    TRANSPARENT,
};
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl};
use windows::Win32::UI::Controls::SetScrollInfo;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetFocus, SetFocus, VK_DOWN, VK_END, VK_HOME, VK_NEXT, VK_PRIOR, VK_SPACE, VK_UP,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::{
    IPreviewHandler, IPreviewHandlerFrame, IPreviewHandlerVisuals, IPreviewHandlerVisuals_Impl, IPreviewHandler_Impl,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetScrollInfo, GetWindowLongPtrW, LoadCursorW,
    RegisterClassW, SetWindowLongPtrW, SetWindowPos, UnregisterClassW, CREATESTRUCTW, GWLP_USERDATA, IDC_ARROW, MSG,
    SB_BOTTOM, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP, SB_THUMBTRACK, SB_TOP, SB_VERT, SCROLLINFO, SIF_ALL,
    SIF_PAGE, SIF_POS, SIF_RANGE, SIF_TRACKPOS, SWP_NOACTIVATE, SWP_NOZORDER, WINDOW_EX_STYLE, WM_APP, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_MOUSEWHEEL, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SIZE, WM_VSCROLL, WNDCLASSW,
    WS_CHILD, WS_CLIPCHILDREN, WS_VISIBLE, WS_VSCROLL,
};

const CLASS_NAME: PCWSTR = w!("EzReaderPdfPreview");
const LINE: i32 = 48;
const WM_COLORS: u32 = WM_APP + 1;

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
struct Colors {
    background: COLORREF,
    text: COLORREF,
}

fn system_colors() -> Colors {
    unsafe { Colors { background: COLORREF(GetSysColor(COLOR_WINDOW)), text: COLORREF(GetSysColor(COLOR_WINDOWTEXT)) } }
}

#[implement(IPreviewHandler, IOleWindow, IObjectWithSite, IInitializeWithStream, IPreviewHandlerVisuals)]
pub struct PreviewHandler {
    stream: RefCell<Option<IStream>>,
    site: RefCell<Option<windows_core::IUnknown>>,
    parent: Cell<HWND>,
    rect: Cell<RECT>,
    window: Cell<HWND>,
    colors: Cell<Colors>,
    _alive: Alive,
}

impl PreviewHandler {
    pub fn new() -> Self {
        PreviewHandler {
            stream: RefCell::new(None),
            site: RefCell::new(None),
            parent: Cell::new(HWND::default()),
            rect: Cell::new(RECT::default()),
            window: Cell::new(HWND::default()),
            colors: Cell::new(system_colors()),
            _alive: Alive::new(),
        }
    }

    fn close_window(&self) {
        let window = self.window.replace(HWND::default());
        if !window.is_invalid() {
            let _ = unsafe { DestroyWindow(window) };
        }
    }

    fn place_window(&self) {
        let window = self.window.get();
        if window.is_invalid() {
            return;
        }
        let r = self.rect.get();
        let _ = unsafe {
            SetWindowPos(window, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE)
        };
    }

    fn send_colors(&self) {
        let window = self.window.get();
        if !window.is_invalid() {
            let c = self.colors.get();
            unsafe {
                windows::Win32::UI::WindowsAndMessaging::SendMessageW(
                    window,
                    WM_COLORS,
                    Some(WPARAM(c.background.0 as usize)),
                    Some(LPARAM(c.text.0 as isize)),
                )
            };
        }
    }
}

impl Drop for PreviewHandler {
    fn drop(&mut self) {
        self.close_window();
    }
}

impl IInitializeWithStream_Impl for PreviewHandler_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> Result<()> {
        *self.stream.borrow_mut() = Some(stream.ok()?.clone());
        Ok(())
    }
}

impl IPreviewHandler_Impl for PreviewHandler_Impl {
    fn SetWindow(&self, parent: HWND, rect: *const RECT) -> Result<()> {
        if rect.is_null() {
            return Err(E_INVALIDARG.into());
        }
        self.parent.set(parent);
        self.rect.set(unsafe { *rect });
        let window = self.window.get();
        if !window.is_invalid() {
            unsafe { windows::Win32::UI::WindowsAndMessaging::SetParent(window, Some(parent))? };
            self.place_window();
        }
        Ok(())
    }

    fn SetRect(&self, rect: *const RECT) -> Result<()> {
        if rect.is_null() {
            return Err(E_INVALIDARG.into());
        }
        self.rect.set(unsafe { *rect });
        self.place_window();
        Ok(())
    }

    fn DoPreview(&self) -> Result<()> {
        if !self.window.get().is_invalid() {
            return Ok(());
        }
        let stream = self.stream.borrow().clone().ok_or(windows::core::Error::from(E_UNEXPECTED))?;
        let document = pdf::read_all(&stream).and_then(|bytes| pdf::open(&bytes)).ok();
        let viewer = Box::new(Viewer::new(document, self.colors.get()));
        register_class();
        let r = self.rect.get();
        let raw = Box::into_raw(viewer);
        let created = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS_NAME,
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_CLIPCHILDREN,
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                Some(self.parent.get()),
                None,
                Some(crate::module()),
                Some(raw as *const c_void),
            )
        };
        match created {
            Ok(window) => {
                self.window.set(window);
                Ok(())
            }
            Err(e) => {
                if unsafe { (*raw).window.is_invalid() } {
                    drop(unsafe { Box::from_raw(raw) });
                }
                Err(e)
            }
        }
    }

    fn Unload(&self) -> Result<()> {
        self.close_window();
        *self.stream.borrow_mut() = None;
        Ok(())
    }

    fn SetFocus(&self) -> Result<()> {
        let window = self.window.get();
        if !window.is_invalid() {
            let _ = unsafe { SetFocus(Some(window)) };
        }
        Ok(())
    }

    fn QueryFocus(&self) -> Result<HWND> {
        let focus = unsafe { GetFocus() };
        if focus.is_invalid() {
            Err(E_FAIL.into())
        } else {
            Ok(focus)
        }
    }

    fn TranslateAccelerator(&self, message: *const MSG) -> Result<()> {
        let frame = self.site.borrow().as_ref().and_then(|s| s.cast::<IPreviewHandlerFrame>().ok());
        let hr = match frame {
            Some(frame) => unsafe {
                (Interface::vtable(&frame).TranslateAccelerator)(Interface::as_raw(&frame), message)
            },
            None => S_FALSE,
        };
        if hr == windows::Win32::Foundation::S_OK {
            Ok(())
        } else {
            Err(S_FALSE.into())
        }
    }
}

impl IOleWindow_Impl for PreviewHandler_Impl {
    fn GetWindow(&self) -> Result<HWND> {
        let window = self.window.get();
        if window.is_invalid() {
            Err(E_FAIL.into())
        } else {
            Ok(window)
        }
    }

    fn ContextSensitiveHelp(&self, _enter: windows::core::BOOL) -> Result<()> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }
}

impl IObjectWithSite_Impl for PreviewHandler_Impl {
    fn SetSite(&self, site: Ref<windows_core::IUnknown>) -> Result<()> {
        *self.site.borrow_mut() = site.cloned();
        Ok(())
    }

    fn GetSite(&self, iid: *const GUID, out: *mut *mut c_void) -> Result<()> {
        if out.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        match self.site.borrow().as_ref() {
            Some(site) => unsafe { site.query(iid, out).ok() },
            None => Err(E_FAIL.into()),
        }
    }
}

impl IPreviewHandlerVisuals_Impl for PreviewHandler_Impl {
    fn SetBackgroundColor(&self, color: COLORREF) -> Result<()> {
        let mut c = self.colors.get();
        c.background = color;
        self.colors.set(c);
        self.send_colors();
        Ok(())
    }

    fn SetFont(&self, _font: *const windows::Win32::Graphics::Gdi::LOGFONTW) -> Result<()> {
        Ok(())
    }

    fn SetTextColor(&self, color: COLORREF) -> Result<()> {
        let mut c = self.colors.get();
        c.text = color;
        self.colors.set(c);
        self.send_colors();
        Ok(())
    }
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
    colors: Colors,
}

impl Viewer {
    fn new(document: Option<PdfDocument>, colors: Colors) -> Self {
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
            colors,
        }
    }

    fn resize(&mut self, width: i32, height: i32) {
        if width != self.width {
            self.drawn.clear();
            let (slots, total) = layout::column(&self.sizes, width);
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
            let background = CreateSolidBrush(self.colors.background);
            FillRect(buffer_dc, &RECT { left: 0, top: 0, right: w, bottom: h }, background);
            let _ = DeleteObject(HGDIOBJ(background.0));

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
            SetTextColor(dc, self.colors.text);
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
                let _ = SetFocus(Some(window));
                LRESULT(0)
            }
            WM_COLORS => {
                viewer.colors = Colors { background: COLORREF(wparam.0 as u32), text: COLORREF(lparam.0 as u32) };
                let _ = InvalidateRect(Some(window), None, false);
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}
