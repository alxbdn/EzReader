use std::ffi::{c_char, c_void};

type CFStringRef = *const c_void;
type CFBundleRef = *const c_void;

const UTF8: u32 = 0x0800_0100;
const ROLES_ALL: u32 = 0xFFFF_FFFF;
const PDF_TYPE: &str = "com.adobe.pdf";
const PREVIEW: &str = "com.apple.Preview";

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(
        alloc: *const c_void,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: u8,
    ) -> CFStringRef;
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

struct OwnedCfString(CFStringRef);

impl OwnedCfString {
    fn new(s: &str) -> Option<Self> {
        let r = unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0) };
        (!r.is_null()).then_some(OwnedCfString(r))
    }
}

impl Drop for OwnedCfString {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

fn to_string(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let mut buf = vec![0 as c_char; 512];
    if unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) } == 0 {
        return None;
    }
    let c = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) };
    Some(c.to_string_lossy().into_owned())
}

fn own_bundle_id() -> Option<String> {
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return None;
        }
        to_string(CFBundleGetIdentifier(bundle))
    }
}

fn pdf_handler() -> Option<String> {
    let ty = OwnedCfString::new(PDF_TYPE)?;
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
    let status = unsafe { LSSetDefaultRoleHandlerForContentType(ty.0, ROLES_ALL, id.0) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("macOS refused to change the PDF reader (error {status})"))
    }
}

pub fn is_default_pdf_reader() -> bool {
    match (own_bundle_id(), pdf_handler()) {
        (Some(me), Some(handler)) => me.eq_ignore_ascii_case(&handler),
        _ => false,
    }
}

pub fn make_default_pdf_reader() -> Result<(), String> {
    let me = own_bundle_id().ok_or("EzReader does not run from its application bundle")?;
    set_pdf_handler(&me)
}

pub fn stop_being_default_pdf_reader() -> Result<(), String> {
    if is_default_pdf_reader() {
        set_pdf_handler(PREVIEW)?;
    }
    Ok(())
}
