//! Opening and drawing PDF pages with the engine built into Windows.

use std::ffi::c_void;
use windows::core::Result;
use windows::Data::Pdf::{PdfDocument, PdfPage, PdfPageRenderOptions};
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode, ExifOrientationMode,
};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::Foundation::{E_FAIL, E_OUTOFMEMORY};
use windows::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
use windows::Win32::System::Com::IStream;

/// Larger files are not read (a thumbnail is not worth reading them whole).
const MAX_FILE: usize = 512 * 1024 * 1024;

/// Reads the whole file Explorer hands over. The PDF engine then works on a
/// copy in memory, so it never calls back into Explorer's stream from
/// another thread.
pub fn read_all(stream: &IStream) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let mut read = 0u32;
        let hr = unsafe { stream.Read(chunk.as_mut_ptr() as *mut c_void, chunk.len() as u32, Some(&mut read)) };
        hr.ok()?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..read as usize]);
        if data.len() > MAX_FILE {
            return Err(E_OUTOFMEMORY.into());
        }
    }
    Ok(data)
}

/// Opens a PDF from its bytes. Fails on password-protected or broken files.
pub fn open(bytes: &[u8]) -> Result<PdfDocument> {
    let memory = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&memory)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.join()?;
    writer.FlushAsync()?.join()?;
    writer.DetachStream()?;
    memory.Seek(0)?;
    PdfDocument::LoadFromStreamAsync(&memory)?.join()
}

/// The page's size in points, as shown (crop box and rotation applied).
pub fn page_size(page: &PdfPage) -> Result<(f32, f32)> {
    let size = page.Size()?;
    Ok((size.Width, size.Height))
}

/// A page drawn as top-down BGRA pixels on white.
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

/// Draws `page` at `width` × `height` pixels.
pub fn render(page: &PdfPage, width: u32, height: u32) -> Result<Picture> {
    let options = PdfPageRenderOptions::new()?;
    options.SetDestinationWidth(width.max(1))?;
    options.SetDestinationHeight(height.max(1))?;
    let png = InMemoryRandomAccessStream::new()?;
    page.RenderWithOptionsToStreamAsync(&png, &options)?.join()?;
    png.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&png)?.join()?;
    let pixels = decoder
        .GetPixelDataTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &BitmapTransform::new()?,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()?;
    let bgra = pixels.DetachPixelData()?.to_vec();
    let (width, height) = (decoder.PixelWidth()?, decoder.PixelHeight()?);
    if bgra.len() != width as usize * height as usize * 4 {
        return Err(E_FAIL.into());
    }
    Ok(Picture { width, height, bgra })
}

/// The picture as a 32-bit GDI bitmap (the caller owns it).
pub fn to_bitmap(picture: &Picture) -> Result<HBITMAP> {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: picture.width as i32,
            // Negative: rows go top to bottom, as the decoder gives them.
            biHeight: -(picture.height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bitmap = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
    if bits.is_null() {
        return Err(E_OUTOFMEMORY.into());
    }
    unsafe { std::ptr::copy_nonoverlapping(picture.bgra.as_ptr(), bits as *mut u8, picture.bgra.len()) };
    Ok(bitmap)
}
