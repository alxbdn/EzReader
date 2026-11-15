//! What macOS does differently: the app that opens PDFs (Launch Services,
//! not a registry or a .desktop file) and the window's proportions (AppKit
//! keeps them itself while the user resizes).

use std::ffi::{c_char, c_void};

type CFStringRef = *const c_void;
type CFBundleRef = *const c_void;

const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
const ROLES_ALL: u32 = 0xFFFF_FFFF; // kLSRolesAll
/// The type Launch Services gives PDF files.
const PDF_TYPE: &str = "com.adobe.pdf";
/// Where PDFs go back to when EzReader stops being their reader.
const PREVIEW: &str = "com.apple.Preview";

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(alloc: *const c_void, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFRelease(cf: *const c_void);
    fn CFBundleGetMainBundle() -> CFBundleRef;
    fn CFBundleGetIdentifier(bundle: CFBundleRef) -> CFStringRef;
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32) -> CFStringRef;
    fn LSSetDefaultRoleHandlerForContentType(content_type: CFStringRef, role: u32, handler: CFStringRef) -> i32;
}

/// A CFString made here, released when dropped.
struct OwnedCfString(CFStringRef);

impl OwnedCfString {
    fn new(s: &str) -> Option<Self> {
        // SAFETY: the bytes are valid UTF-8 for the given length.
        let r = unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0) };
        (!r.is_null()).then_some(OwnedCfString(r))
    }
}

impl Drop for OwnedCfString {
    fn drop(&mut self) {
        // SAFETY: created by a Create/Copy function, released once.
        unsafe { CFRelease(self.0) }
    }
}

fn to_string(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let mut buf = vec![0 as c_char; 512];
    // SAFETY: `buf` holds `buf.len()` bytes; the result is NUL-terminated.
    if unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) } == 0 {
        return None;
    }
    // SAFETY: CFStringGetCString wrote a NUL-terminated string.
    let c = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) };
    Some(c.to_string_lossy().into_owned())
}

/// This app's bundle identifier, or `None` when it does not run from its
/// .app bundle (`cargo run`): Launch Services only knows bundles.
fn own_bundle_id() -> Option<String> {
    // SAFETY: Get functions: nothing to release.
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return None;
        }
        to_string(CFBundleGetIdentifier(bundle))
    }
}

/// The bundle identifier of the app PDFs open with.
fn pdf_handler() -> Option<String> {
    let ty = OwnedCfString::new(PDF_TYPE)?;
    // SAFETY: a Copy function: the result is ours to release.
    let handler = unsafe { LSCopyDefaultRoleHandlerForContentType(ty.0, ROLES_ALL) };
    if handler.is_null() {
        return None;
    }
    let handler = OwnedCfString(handler);
    to_string(handler.0)
}

fn set_pdf_handler(bundle_id: &str) -> Result<(), String> {
    let ty = OwnedCfString::new(PDF_TYPE).ok_or("CFString")?;
    let id = OwnedCfString::new(bundle_id).ok_or("CFString")?;
    // SAFETY: both strings live until the end of the call.
    let status = unsafe { LSSetDefaultRoleHandlerForContentType(ty.0, ROLES_ALL, id.0) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("macOS refused to change the PDF reader (error {status})"))
    }
}

/// True when PDFs open with EzReader.
pub fn is_default_pdf_reader() -> bool {
    match (own_bundle_id(), pdf_handler()) {
        (Some(me), Some(handler)) => me.eq_ignore_ascii_case(&handler),
        _ => false,
    }
}

/// Makes EzReader the app PDFs open with.
pub fn make_default_pdf_reader() -> Result<(), String> {
    let me = own_bundle_id().ok_or("EzReader does not run from its application bundle")?;
    set_pdf_handler(&me)
}

/// Gives PDFs back to Preview, if they opened with EzReader.
pub fn stop_being_default_pdf_reader() -> Result<(), String> {
    if is_default_pdf_reader() {
        set_pdf_handler(PREVIEW)?;
    }
    Ok(())
}

// ── Window proportions ──────────────────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}

// SAFETY: same layout as CGSize, two doubles.
unsafe impl objc2::Encode for NSSize {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}

/// Keeps the window's present proportions while it is resized (`locked`),
/// or frees them. AppKit applies the ratio during the drag itself.
pub fn set_ratio_lock(window: &tauri::WebviewWindow, locked: bool) {
    let Ok(ns_window) = window.ns_window() else { return };
    let size = window.inner_size().ok();
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || {
        let obj = ns_window as *mut objc2::runtime::AnyObject;
        if obj.is_null() {
            return;
        }
        // SAFETY: `obj` is the window's live NSWindow, used on the main thread.
        unsafe {
            match size {
                Some(s) if locked && s.width > 0 && s.height > 0 => {
                    let ratio = NSSize { width: s.width as f64, height: s.height as f64 };
                    let _: () = objc2::msg_send![obj, setContentAspectRatio: ratio];
                }
                // Resize increments replace the aspect ratio: 1 × 1 is free.
                _ => {
                    let free = NSSize { width: 1.0, height: 1.0 };
                    let _: () = objc2::msg_send![obj, setContentResizeIncrements: free];
                }
            }
        }
    });
}
