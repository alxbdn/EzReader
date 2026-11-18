//! Thumbnail provider: page 1 of the PDF as its icon in Explorer.

use crate::{layout, pdf, Alive};
use std::cell::RefCell;
use windows::core::{implement, Ref, Result};
use windows::Win32::Foundation::{E_POINTER, E_UNEXPECTED};
use windows::Win32::Graphics::Gdi::HBITMAP;
use windows::Win32::System::Com::IStream;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::{IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_RGB, WTS_ALPHATYPE};

#[implement(IThumbnailProvider, IInitializeWithStream)]
pub struct ThumbnailProvider {
    stream: RefCell<Option<IStream>>,
    _alive: Alive,
}

impl ThumbnailProvider {
    pub fn new() -> Self {
        ThumbnailProvider { stream: RefCell::new(None), _alive: Alive::new() }
    }
}

impl IInitializeWithStream_Impl for ThumbnailProvider_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> Result<()> {
        let mut slot = self.stream.borrow_mut();
        if slot.is_some() {
            return Err(E_UNEXPECTED.into());
        }
        *slot = Some(stream.ok()?.clone());
        Ok(())
    }
}

impl IThumbnailProvider_Impl for ThumbnailProvider_Impl {
    fn GetThumbnail(&self, side: u32, bitmap: *mut HBITMAP, alpha: *mut WTS_ALPHATYPE) -> Result<()> {
        if bitmap.is_null() || alpha.is_null() {
            return Err(E_POINTER.into());
        }
        let stream = self.stream.borrow().clone().ok_or(windows::core::Error::from(E_UNEXPECTED))?;
        let document = pdf::open(&pdf::read_all(&stream)?)?;
        let page = document.GetPage(0)?;
        let (w, h) = pdf::page_size(&page)?;
        let (width, height) = layout::fit_in_square(w, h, side);
        let picture = pdf::render(&page, width, height)?;
        unsafe {
            *bitmap = pdf::to_bitmap(&picture)?;
            *alpha = WTSAT_RGB;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HGDIOBJ};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, STGM_READ};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;

    fn corpus(name: &str) -> IStream {
        let path = format!("{}/../tests/corpus/{name}", env!("CARGO_MANIFEST_DIR"));
        unsafe { SHCreateStreamOnFileEx(&HSTRING::from(path), STGM_READ.0, 0, false, None) }.unwrap()
    }

    fn thumbnail(name: &str, side: u32) -> Result<(i32, i32)> {
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let provider: IThumbnailProvider = ThumbnailProvider::new().into();
        unsafe { provider.cast::<IInitializeWithStream>()?.Initialize(&corpus(name), STGM_READ.0)? };
        let mut bitmap = HBITMAP::default();
        let mut alpha = WTS_ALPHATYPE::default();
        unsafe { provider.GetThumbnail(side, &mut bitmap, &mut alpha)? };
        let mut info = BITMAP::default();
        let got = unsafe {
            GetObjectW(HGDIOBJ(bitmap.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut _))
        };
        let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
        assert!(got > 0);
        assert_eq!(alpha, WTSAT_RGB);
        Ok((info.bmWidth, info.bmHeight.abs()))
    }

    #[test]
    fn draws_page_one_at_the_asked_size() {
        let (w, h) = thumbnail("pdf15-object-streams.pdf", 256).unwrap();
        assert_eq!(w.max(h), 256);
        assert!(w.min(h) > 0);
    }

    #[test]
    fn password_protected_files_keep_the_generic_icon() {
        assert!(thumbnail("encrypted-aes-256.pdf", 96).is_err());
    }

    #[test]
    fn broken_files_keep_the_generic_icon() {
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        assert!(pdf::open(b"%PDF-1.7 not really").is_err());
    }
}
