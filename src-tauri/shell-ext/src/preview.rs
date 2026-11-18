use crate::{pdf, viewer, Alive};
use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use windows::core::{implement, Interface, Ref, Result, GUID};
use windows::Win32::Foundation::{
    COLORREF, E_FAIL, E_INVALIDARG, E_POINTER, E_UNEXPECTED, HWND, LPARAM, RECT, S_FALSE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{GetSysColor, COLOR_WINDOW, COLOR_WINDOWTEXT};
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::{
    IPreviewHandler, IPreviewHandlerFrame, IPreviewHandlerVisuals, IPreviewHandlerVisuals_Impl, IPreviewHandler_Impl,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, SetWindowPos, MSG, SWP_NOACTIVATE, SWP_NOZORDER};

#[derive(Clone, Copy)]
struct Colors {
    background: COLORREF,
    text: COLORREF,
}

fn system_colors() -> Colors {
    unsafe { Colors { background: COLORREF(GetSysColor(COLOR_WINDOW)), text: COLORREF(GetSysColor(COLOR_WINDOWTEXT)) } }
}

impl Colors {
    fn style(self) -> viewer::Style {
        viewer::Style { background: self.background, text: self.text, dots: None, fit_height: false, take_focus: true }
    }
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
                    viewer::WM_VIEWER_COLORS,
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
        let window = viewer::create(self.parent.get(), self.rect.get(), document, self.colors.get().style())?;
        self.window.set(window);
        Ok(())
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
