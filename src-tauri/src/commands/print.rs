use crate::error::CmdResult;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterList {
    pub printers: Vec<String>,
    pub default_printer: String,
}

#[tauri::command]
pub fn list_printers() -> CmdResult<PrinterList> {
    #[cfg(target_os = "windows")]
    {
        list_printers_impl().map_err(crate::error::PdfError::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_printers_linux().map_err(crate::error::PdfError::from)
    }
}

#[cfg(not(target_os = "windows"))]
fn parse_lpstat_printers(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter(|line| line.contains(" accepting requests"))
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn parse_lpstat_default(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.split_once("system default destination:").map(|(_, rest)| rest.trim()))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(not(target_os = "windows"))]
fn list_printers_linux() -> Result<PrinterList, String> {
    let Ok(out) = std::process::Command::new("lpstat").env("LC_ALL", "C").arg("-a").output() else {
        return Ok(PrinterList { printers: vec![], default_printer: String::new() });
    };
    if !out.status.success() {
        return Ok(PrinterList { printers: vec![], default_printer: String::new() });
    }
    let printers = parse_lpstat_printers(&String::from_utf8_lossy(&out.stdout));
    let default_printer = std::process::Command::new("lpstat")
        .env("LC_ALL", "C")
        .arg("-d")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_lpstat_default(&String::from_utf8_lossy(&o.stdout)))
        .filter(|d| printers.iter().any(|p| p == d))
        .or_else(|| printers.first().cloned())
        .unwrap_or_default();

    Ok(PrinterList { printers, default_printer })
}

#[cfg(target_os = "windows")]
fn get_default_printer_name() -> Result<String, String> {
    use winapi::um::winspool::GetDefaultPrinterW;

    let mut size = 256u32;
    let mut name_buf = vec![0u16; size as usize];
    let ok = unsafe { GetDefaultPrinterW(name_buf.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return Err("No default printer found".to_string());
    }
    Ok(String::from_utf16_lossy(&name_buf[..size as usize]).trim_end_matches('\0').to_string())
}

#[cfg(target_os = "windows")]
fn list_printers_impl() -> Result<PrinterList, String> {
    use std::ptr;
    use winapi::um::winspool::EnumPrintersW;

    const PRINTER_ENUM_LOCAL: u32 = 0x2;
    const PRINTER_ENUM_CONNECTIONS: u32 = 0x4;
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;

    let mut needed: u32 = 0;
    let mut returned: u32 = 0;
    unsafe {
        EnumPrintersW(flags, ptr::null_mut(), 2, ptr::null_mut(), 0, &mut needed, &mut returned);
    }

    if needed == 0 {
        let default = get_default_printer_name().unwrap_or_default();
        return Ok(PrinterList { printers: vec![], default_printer: default });
    }

    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let ok = unsafe {
        EnumPrintersW(flags, ptr::null_mut(), 2, buf.as_mut_ptr().cast::<u8>(), needed, &mut needed, &mut returned)
    };
    if ok == 0 {
        let default = get_default_printer_name().unwrap_or_default();
        return Ok(PrinterList { printers: vec![], default_printer: default });
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PrinterInfo2W {
        pServerName: *mut u16,
        pPrinterName: *mut u16,
        pShareName: *mut u16,
        pPortName: *mut u16,
        pDriverName: *mut u16,
        pComment: *mut u16,
        pLocation: *mut u16,
        pDevMode: *mut u8,
        pSepFile: *mut u16,
        pPrintProcessor: *mut u16,
        pDatatype: *mut u16,
        pParameters: *mut u16,
        pSecurityDescriptor: *mut u8,
        Attributes: u32,
        Priority: u32,
        DefaultPriority: u32,
        StartTime: u32,
        UntilTime: u32,
        Status: u32,
        cJobs: u32,
        AveragePPM: u32,
    }

    let info_ptr = buf.as_ptr() as *const PrinterInfo2W;
    let mut printers = Vec::with_capacity(returned as usize);
    for i in 0..returned as isize {
        let info = unsafe { &*info_ptr.offset(i) };
        if !info.pPrinterName.is_null() {
            let name_len = unsafe {
                let mut len = 0;
                while *info.pPrinterName.add(len) != 0 {
                    len += 1;
                }
                len
            };
            let name_slice = unsafe { std::slice::from_raw_parts(info.pPrinterName, name_len) };
            printers.push(String::from_utf16_lossy(name_slice));
        }
    }

    let default = get_default_printer_name().unwrap_or_default();
    Ok(PrinterList { printers, default_printer: default })
}

#[tauri::command(async)]
pub fn print_pages(
    pages_b64: Vec<String>,
    printer_name: Option<String>,
    copies: Option<u32>,
    orientation: Option<String>,
    fit_mode: Option<String>,
) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        print_pages_impl(pages_b64, printer_name, copies, orientation, fit_mode).map_err(crate::error::PdfError::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        print_pages_linux(pages_b64, printer_name, copies, orientation, fit_mode).map_err(crate::error::PdfError::from)
    }
}

#[cfg(not(target_os = "windows"))]
fn print_pages_linux(
    pages_b64: Vec<String>,
    printer_name: Option<String>,
    copies: Option<u32>,
    orientation: Option<String>,
    fit_mode: Option<String>,
) -> Result<(), String> {
    use base64::Engine;

    if pages_b64.is_empty() {
        return Err("No pages to print".into());
    }

    let mut decoded_pages = Vec::with_capacity(pages_b64.len());
    for page_b64 in &pages_b64 {
        let trimmed = page_b64.split_once(',').map_or(page_b64.as_str(), |(_, d)| d).trim();
        let bytes = base64::engine::general_purpose::STANDARD.decode(trimmed).map_err(|e| format!("base64: {e}"))?;
        decoded_pages.push((format!("page {}", decoded_pages.len() + 1), bytes));
    }

    struct TempCleanup(std::path::PathBuf);
    impl Drop for TempCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp_path = std::env::temp_dir().join(format!("ezreader-{}-print-{nanos}.pdf", crate::tempfiles::tag()));
    let _cleanup = TempCleanup(temp_path.clone());
    let temp_path_str = temp_path.to_string_lossy().into_owned();

    crate::commands::pdf::image_bytes_to_pdf(&decoded_pages, &temp_path_str)?;

    let mut args: Vec<String> = Vec::new();
    if let Some(name) = printer_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        args.push("-d".to_string());
        args.push(name.to_string());
    }
    let num_copies = copies.unwrap_or(1).clamp(1, 999);
    args.push("-n".to_string());
    args.push(num_copies.to_string());

    args.push("-o".to_string());
    args.push(if orientation.as_deref() == Some("landscape") {
        "orientation-requested=4".to_string()
    } else {
        "orientation-requested=3".to_string()
    });

    if fit_mode.as_deref() != Some("actual") {
        args.push("-o".to_string());
        args.push("fit-to-page".to_string());
    }

    args.push(temp_path_str);

    let out = std::process::Command::new("lp").args(&args).output().map_err(|e| format!("failed to run lp: {e}"))?;
    drop(_cleanup);

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "lp failed".to_string() } else { stderr });
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn print_pages_impl(
    pages_b64: Vec<String>,
    printer_name: Option<String>,
    copies: Option<u32>,
    orientation: Option<String>,
    fit_mode: Option<String>,
) -> Result<(), String> {
    use base64::Engine;
    use std::ptr;
    use winapi::shared::windef::HDC;
    use winapi::um::wingdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DOCINFOW,
        HORZRES, LOGPIXELSX, LOGPIXELSY, SRCCOPY, VERTRES,
    };

    let printer_wide: Vec<u16> = match &printer_name {
        Some(name) => {
            let mut v: Vec<u16> = name.encode_utf16().collect();
            v.push(0);
            v
        }
        None => {
            let name = get_default_printer_name()?;
            let mut v: Vec<u16> = name.encode_utf16().collect();
            v.push(0);
            v
        }
    };

    let devmode_buf = orientation.as_deref().and_then(|o| printer_devmode(&printer_wide, o == "landscape"));
    let devmode_ptr = devmode_buf.as_ref().map_or(ptr::null(), |b| b.as_ptr() as *const winapi::um::wingdi::DEVMODEW);

    let hdc: HDC = unsafe { CreateDCW(ptr::null(), printer_wide.as_ptr(), ptr::null(), devmode_ptr) };

    if hdc.is_null() {
        return Err("Failed to create printer DC".to_string());
    }

    let page_w = unsafe { GetDeviceCaps(hdc, HORZRES) };
    let page_h = unsafe { GetDeviceCaps(hdc, VERTRES) };
    let dpi_x = unsafe { GetDeviceCaps(hdc, LOGPIXELSX) };
    let dpi_y = unsafe { GetDeviceCaps(hdc, LOGPIXELSY) };
    let actual_size = fit_mode.as_deref() == Some("actual");

    let doc_name: Vec<u16> = "PDF Document\0".encode_utf16().collect();
    let doc_info = DOCINFOW {
        cbSize: std::mem::size_of::<DOCINFOW>() as i32,
        lpszDocName: doc_name.as_ptr(),
        lpszOutput: ptr::null(),
        lpszDatatype: ptr::null(),
        fwType: 0,
    };
    let job = unsafe { winapi::um::wingdi::StartDocW(hdc, &doc_info) };
    if job <= 0 {
        unsafe { DeleteDC(hdc) };
        return Err("StartDocW failed".to_string());
    }

    let num_copies = copies.unwrap_or(1).clamp(1, 999);

    for _ in 0..num_copies {
        for page_b64 in &pages_b64 {
            let jpeg_bytes = base64::engine::general_purpose::STANDARD
                .decode(page_b64.trim())
                .map_err(|e| format!("base64: {e}"))?;

            let img = image::load_from_memory(&jpeg_bytes).map_err(|e| format!("image decode: {e}"))?.into_rgb8();
            let (img_w, img_h) = img.dimensions();
            let rgb = img.as_raw();

            let row_stride = (img_w as usize * 3 + 3) & !3;
            let mut dib = vec![0u8; row_stride * img_h as usize];
            for y in 0..img_h as usize {
                for x in 0..img_w as usize {
                    let s = y * img_w as usize * 3 + x * 3;
                    let d = y * row_stride + x * 3;
                    dib[d] = rgb[s + 2];
                    dib[d + 1] = rgb[s + 1];
                    dib[d + 2] = rgb[s];
                }
            }

            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: img_w as i32,
                    biHeight: -(img_h as i32),
                    biPlanes: 1,
                    biBitCount: 24,
                    biCompression: 0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [winapi::um::wingdi::RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }],
            };

            let (dest_x, dest_y, dest_w, dest_h) = if actual_size {
                let w = (img_w as i64 * dpi_x as i64 / 200) as i32;
                let h = (img_h as i64 * dpi_y as i64 / 200) as i32;
                let x = (page_w - w) / 2;
                let y = (page_h - h) / 2;
                (x.max(0), y.max(0), w.min(page_w), h.min(page_h))
            } else {
                let (w, h) = fit_within(img_w, img_h, page_w, page_h);
                ((page_w - w) / 2, (page_h - h) / 2, w, h)
            };

            unsafe { winapi::um::wingdi::StartPage(hdc) };
            unsafe {
                StretchDIBits(
                    hdc,
                    dest_x,
                    dest_y,
                    dest_w,
                    dest_h,
                    0,
                    0,
                    img_w as i32,
                    img_h as i32,
                    dib.as_ptr() as *const _,
                    &bmi,
                    DIB_RGB_COLORS,
                    SRCCOPY,
                )
            };
            unsafe { winapi::um::wingdi::EndPage(hdc) };
        }
    }

    unsafe { winapi::um::wingdi::EndDoc(hdc) };
    unsafe { DeleteDC(hdc) };

    Ok(())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn fit_within(img_w: u32, img_h: u32, max_w: i32, max_h: i32) -> (i32, i32) {
    if img_w == 0 || img_h == 0 || max_w <= 0 || max_h <= 0 {
        return (max_w.max(0), max_h.max(0));
    }
    if max_w as i64 * img_h as i64 <= max_h as i64 * img_w as i64 {
        (max_w, (img_h as i64 * max_w as i64 / img_w as i64) as i32)
    } else {
        ((img_w as i64 * max_h as i64 / img_h as i64) as i32, max_h)
    }
}

#[cfg(target_os = "windows")]
fn printer_devmode(printer_wide: &[u16], landscape: bool) -> Option<Vec<u8>> {
    use std::ptr;
    use winapi::um::wingdi::{DEVMODEW, DMORIENT_LANDSCAPE, DMORIENT_PORTRAIT, DM_ORIENTATION};
    use winapi::um::winspool::{ClosePrinter, DocumentPropertiesW, OpenPrinterW};

    const DM_OUT_BUFFER: u32 = 2;
    const DM_IN_BUFFER: u32 = 8;

    let mut name = printer_wide.to_vec();
    let mut handle = ptr::null_mut();
    if unsafe { OpenPrinterW(name.as_mut_ptr(), &mut handle, ptr::null_mut()) } == 0 {
        return None;
    }

    let result = (|| {
        let size = unsafe {
            DocumentPropertiesW(ptr::null_mut(), handle, name.as_mut_ptr(), ptr::null_mut(), ptr::null_mut(), 0)
        };
        if size < std::mem::size_of::<DEVMODEW>() as i32 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let dm = buf.as_mut_ptr() as *mut DEVMODEW;
        let ok = unsafe {
            DocumentPropertiesW(ptr::null_mut(), handle, name.as_mut_ptr(), dm, ptr::null_mut(), DM_OUT_BUFFER)
        };
        if ok < 0 {
            return None;
        }
        unsafe {
            let dm = &mut *dm;
            dm.dmFields |= DM_ORIENTATION;
            dm.u1.s1_mut().dmOrientation = if landscape { DMORIENT_LANDSCAPE } else { DMORIENT_PORTRAIT } as i16;
        }
        let ok = unsafe {
            DocumentPropertiesW(ptr::null_mut(), handle, name.as_mut_ptr(), dm, dm, DM_IN_BUFFER | DM_OUT_BUFFER)
        };
        if ok < 0 {
            return None;
        }
        Some(buf)
    })();

    unsafe { ClosePrinter(handle) };
    result
}

#[cfg(test)]
mod tests {
    use super::fit_within;

    #[test]
    fn fit_within_keeps_aspect_ratio() {
        assert_eq!(fit_within(1000, 1414, 4800, 6600), (4667, 6600));
        assert_eq!(fit_within(1414, 1000, 4800, 6600), (4800, 3394));
        assert_eq!(fit_within(100, 200, 50, 100), (50, 100));
    }

    #[test]
    fn fit_within_degenerate_inputs() {
        assert_eq!(fit_within(0, 100, 50, 100), (50, 100));
        assert_eq!(fit_within(100, 100, 0, 100), (0, 100));
    }

    #[cfg(not(windows))]
    #[test]
    fn parses_lpstat_output() {
        let lpstat_a = concat!(
            "HP_LaserJet accepting requests since Mon Nov 10 10:00:00 2026\n",
            "CUPS-PDF accepting requests since Tue Nov 11 08:00:00 2026\n",
        );
        assert_eq!(super::parse_lpstat_printers(lpstat_a), vec!["HP_LaserJet".to_string(), "CUPS-PDF".to_string()]);
        assert_eq!(
            super::parse_lpstat_default("system default destination: HP_LaserJet\n").as_deref(),
            Some("HP_LaserJet")
        );
        assert_eq!(super::parse_lpstat_default("no system default destination\n"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn printers_and_their_settings_can_be_read() {
        let list = super::list_printers_impl().unwrap();
        let _ = super::get_default_printer_name();
        let _ = crate::commands::default_reader::is_windows_10();
        assert!(!crate::commands::shell::is_packaged());
        for name in list.printers.iter().take(3) {
            let mut wide: Vec<u16> = name.encode_utf16().collect();
            wide.push(0);
            let _ = super::printer_devmode(&wide, true);
            let _ = super::printer_devmode(&wide, false);
        }
    }
}
