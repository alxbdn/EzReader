use crate::error::{CmdResult, PdfError};
use std::process::Command;
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn get_startup_args(window: tauri::WebviewWindow, state: State<AppState>) -> crate::StartupArgs {
    if window.label() == "main" {
        let args = state.startup_args.lock().unwrap();
        state.startup_taken.store(true, std::sync::atomic::Ordering::SeqCst);
        return args.clone();
    }
    state.window_args.lock().unwrap().get(window.label()).cloned().unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn is_packaged() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_ascii_lowercase().contains(r"\windowsapps\"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn desktop_file_path() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
        .map(|d| d.join("applications").join("ezreader.desktop"))
}

#[cfg(not(target_os = "windows"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn mimeapps_list_path() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .map(|d| d.join("mimeapps.list"))
}

#[cfg(not(target_os = "windows"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn desktop_entry_exists() -> bool {
    desktop_file_path().is_some_and(|p| p.exists())
        || std::path::Path::new("/usr/share/applications/ezreader.desktop").exists()
        || std::path::Path::new("/usr/share/applications/EzReader.desktop").exists()
}

#[tauri::command]
pub fn check_pdf_association() -> bool {
    #[cfg(target_os = "windows")]
    {
        if is_packaged() {
            return false;
        }
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(r"Software\Classes\com.ezreader.app\shell\open\command").is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::is_default_pdf_reader()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if !desktop_entry_exists() {
            return false;
        }
        let Ok(out) = Command::new("xdg-mime").args(["query", "default", "application/pdf"]).output() else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase().contains("ezreader")
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn package_family_from_exe(exe: &str) -> Option<String> {
    let lower = exe.to_ascii_lowercase();
    let start = lower.find(r"\windowsapps\")? + r"\windowsapps\".len();
    let full = exe[start..].split('\\').next()?;
    let parts: Vec<&str> = full.split('_').collect();
    if parts.len() < 3 || parts[0].is_empty() || parts[parts.len() - 1].is_empty() {
        return None;
    }
    Some(format!("{}_{}", parts[0], parts[parts.len() - 1]))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn prog_id_is_ours(prog_id: &str, exe_name: &str, app_user_model_id: Option<&str>, family: Option<&str>) -> bool {
    if prog_id.eq_ignore_ascii_case("com.ezreader.app") {
        return true;
    }
    if !exe_name.is_empty() && prog_id.eq_ignore_ascii_case(&format!(r"Applications\{exe_name}")) {
        return true;
    }
    match (app_user_model_id, family) {
        (Some(aumid), Some(family)) => aumid.split('!').next().is_some_and(|f| f.eq_ignore_ascii_case(family)),
        _ => false,
    }
}

#[tauri::command]
pub fn is_default_pdf_reader() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
        use winreg::RegKey;
        const EXTS: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let read = |key: &str| {
            hkcu.open_subkey(format!(r"{EXTS}\{key}"))
                .and_then(|k| k.get_value::<String, _>("ProgId"))
                .ok()
                .filter(|v| !v.is_empty())
        };
        let Some(prog_id) =
            read("UserChoiceLatest").or_else(|| read(r"UserChoiceLatest\ProgId")).or_else(|| read("UserChoice"))
        else {
            return false;
        };
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let exe_name =
            std::path::Path::new(&exe).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let aumid = RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(format!(r"{prog_id}\Application"))
            .and_then(|k| k.get_value::<String, _>("AppUserModelID"))
            .ok();
        let family = package_family_from_exe(&exe);
        prog_id_is_ours(&prog_id, &exe_name, aumid.as_deref(), family.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        check_pdf_association()
    }
}

#[cfg(test)]
mod default_reader_tests {
    use super::{package_family_from_exe, prog_id_is_ours};

    #[test]
    fn family_comes_from_the_windowsapps_folder() {
        assert_eq!(
            package_family_from_exe(
                r"C:\Program Files\WindowsApps\AlexBoudon.EzReader_1.0.0.0_x64__8wekyb3d8bbwe\ezreader.exe"
            )
            .as_deref(),
            Some("AlexBoudon.EzReader_8wekyb3d8bbwe")
        );
        assert_eq!(package_family_from_exe(r"C:\Users\a\Downloads\ezreader-portable.exe"), None);
    }

    #[test]
    fn our_prog_ids_are_recognised() {
        assert!(prog_id_is_ours("com.ezreader.app", "ezreader.exe", None, None));
        assert!(prog_id_is_ours(r"Applications\ezreader-portable.exe", "ezreader-portable.exe", None, None));
        assert!(prog_id_is_ours(
            "AppXabc123",
            "ezreader.exe",
            Some("AlexBoudon.EzReader_8wekyb3d8bbwe!App"),
            Some("alexboudon.ezreader_8wekyb3d8bbwe")
        ));
    }

    #[test]
    fn other_readers_are_not_ours() {
        assert!(!prog_id_is_ours("AcroExch.Document.DC", "ezreader.exe", None, None));
        assert!(!prog_id_is_ours("MSEdgePDF", "ezreader.exe", None, Some("AlexBoudon.EzReader_8wekyb3d8bbwe")));
        assert!(!prog_id_is_ours(
            "AppXother",
            "ezreader.exe",
            Some("Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MSEDGE"),
            Some("AlexBoudon.EzReader_8wekyb3d8bbwe")
        ));
        assert!(!prog_id_is_ours(r"Applications\", "", None, None));
    }
}

#[tauri::command]
pub fn register_pdf_handler() -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        if is_packaged() {
            return Ok(());
        }
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;

        let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu.open_subkey_with_flags(r"Software\Classes", KEY_SET_VALUE).map_err(|e| e.to_string())?;

        let (progid, _) = classes.create_subkey("com.ezreader.app").map_err(|e| e.to_string())?;
        progid.set_value("", &"EzReader Document").map_err(|e| e.to_string())?;
        progid.set_value("FriendlyTypeName", &"EzReader Document").map_err(|e| e.to_string())?;

        let (icon_key, _) = progid.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
        icon_key.set_value("", &format!("\"{exe}\",0")).map_err(|e| e.to_string())?;

        let (open_cmd, _) = progid.create_subkey(r"shell\open\command").map_err(|e| e.to_string())?;
        open_cmd.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(|e| e.to_string())?;

        let (print_cmd, _) = progid.create_subkey(r"shell\print\command").map_err(|e| e.to_string())?;
        print_cmd.set_value("", &format!("\"{exe}\" --print \"%1\"")).map_err(|e| e.to_string())?;

        let (pdf_ext, _) = classes.create_subkey(".pdf").map_err(|e| e.to_string())?;
        pdf_ext.set_value("", &"com.ezreader.app").map_err(|e| e.to_string())?;
        let (open_with, _) = pdf_ext.create_subkey("OpenWithProgids").map_err(|e| e.to_string())?;
        open_with.set_value("com.ezreader.app", &"").map_err(|e| e.to_string())?;

        let exe_name = std::path::Path::new(&exe)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "ezreader.exe".to_string());
        let app_key_path = format!(r"Software\Classes\Applications\{exe_name}");
        let (app_key, _) = hkcu.create_subkey(&app_key_path).map_err(|e| e.to_string())?;
        app_key.set_value("NoOpenWith", &"").map_err(|e| e.to_string())?;
        let (app_print_cmd, _) = app_key.create_subkey(r"shell\print\command").map_err(|e| e.to_string())?;
        app_print_cmd.set_value("", &format!("\"{exe}\" --print \"%1\"")).map_err(|e| e.to_string())?;

        let (capabilities, _) = hkcu.create_subkey(CAPABILITIES_KEY).map_err(|e| e.to_string())?;
        capabilities.set_value("ApplicationName", &"EzReader").map_err(|e| e.to_string())?;
        capabilities
            .set_value("ApplicationDescription", &"A simple, lightweight PDF reader")
            .map_err(|e| e.to_string())?;
        let (file_assoc, _) = capabilities.create_subkey("FileAssociations").map_err(|e| e.to_string())?;
        file_assoc.set_value(".pdf", &"com.ezreader.app").map_err(|e| e.to_string())?;
        let (registered, _) = hkcu.create_subkey(r"Software\RegisteredApplications").map_err(|e| e.to_string())?;
        registered.set_value(REGISTERED_APP_NAME, &CAPABILITIES_KEY).map_err(|e| e.to_string())?;

        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::make_default_pdf_reader().map_err(PdfError::from)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let desktop_path =
            desktop_file_path().ok_or_else(|| PdfError::from("Could not locate applications directory"))?;
        if let Some(parent) = desktop_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let desktop = format!(
            "[Desktop Entry]\nType=Application\nName=EzReader\nComment=PDF Reader and Editor\nExec=\"{exe}\" %F\nTerminal=false\nMimeType=application/pdf;\nCategories=Office;Viewer;\n"
        );
        std::fs::write(&desktop_path, desktop).map_err(|e| e.to_string())?;

        let status = Command::new("xdg-mime")
            .args(["default", "ezreader.desktop", "application/pdf"])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("xdg-mime failed to set application/pdf default".into());
        }
        Ok(())
    }
}

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
        list_printers_impl().map_err(PdfError::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_printers_linux().map_err(PdfError::from)
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
    let Ok(out) = Command::new("lpstat").env("LC_ALL", "C").arg("-a").output() else {
        return Ok(PrinterList { printers: vec![], default_printer: String::new() });
    };
    if !out.status.success() {
        return Ok(PrinterList { printers: vec![], default_printer: String::new() });
    }
    let printers = parse_lpstat_printers(&String::from_utf8_lossy(&out.stdout));
    let default_printer = Command::new("lpstat")
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
        print_pages_impl(pages_b64, printer_name, copies, orientation, fit_mode).map_err(PdfError::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        print_pages_linux(pages_b64, printer_name, copies, orientation, fit_mode).map_err(PdfError::from)
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

    let out = Command::new("lp").args(&args).output().map_err(|e| format!("failed to run lp: {e}"))?;
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
    fn parses_lpstat_output_and_strips_mimeapps() {
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

        let mimeapps = concat!(
            "[Default Applications]\n",
            "application/pdf=ezreader.desktop\n",
            "text/plain=gedit.desktop\n",
            "[Added Associations]\n",
            "application/pdf=ezreader.desktop;org.gnome.Evince.desktop;\n",
        );
        let cleaned = super::strip_ezreader_from_mimeapps(mimeapps);
        assert_eq!(
            cleaned,
            concat!(
                "[Default Applications]\n",
                "text/plain=gedit.desktop\n",
                "[Added Associations]\n",
                "application/pdf=org.gnome.Evince.desktop;\n",
            )
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn printers_and_their_settings_can_be_read() {
        let list = super::list_printers_impl().unwrap();
        let _ = super::get_default_printer_name();
        let _ = super::is_windows_10();
        assert!(!super::is_packaged());
        for name in list.printers.iter().take(3) {
            let mut wide: Vec<u16> = name.encode_utf16().collect();
            wide.push(0);
            let _ = super::printer_devmode(&wide, true);
            let _ = super::printer_devmode(&wide, false);
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn strip_ezreader_from_mimeapps(content: &str) -> String {
    let mut out = Vec::new();
    for line in content.lines() {
        if let Some((lhs, rhs)) = line.split_once('=') {
            if lhs.trim() == "application/pdf" {
                let trailing_semi = rhs.trim_end().ends_with(';');
                let kept: Vec<&str> = rhs
                    .split(';')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty() && !entry.eq_ignore_ascii_case("ezreader.desktop"))
                    .collect();
                if !kept.is_empty() {
                    let mut joined = kept.join(";");
                    if trailing_semi {
                        joined.push(';');
                    }
                    out.push(format!("{lhs}={joined}"));
                }
                continue;
            }
        }
        out.push(line.to_string());
    }
    let mut res = out.join("\n");
    if content.ends_with('\n') && !res.is_empty() {
        res.push('\n');
    }
    res
}

#[tauri::command]
pub fn unregister_pdf_handler() -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        if is_packaged() {
            return Ok(());
        }
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        hkcu.delete_subkey_all(r"Software\Classes\com.ezreader.app").ok();

        hkcu.delete_subkey_all(r"Software\Classes\.pdf").ok();

        let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();
        let exe_name = std::path::Path::new(&exe)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "ezreader.exe".to_string());
        hkcu.delete_subkey_all(format!(r"Software\Classes\Applications\{exe_name}")).ok();

        if let Ok(key) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids",
            winreg::enums::KEY_SET_VALUE,
        ) {
            key.delete_value("com.ezreader.app").ok();
        }

        if let Ok(key) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", winreg::enums::KEY_SET_VALUE) {
            key.delete_value(REGISTERED_APP_NAME).ok();
        }
        hkcu.delete_subkey_all(r"Software\EzReader\Capabilities").ok();
        hkcu.delete_subkey(r"Software\EzReader").ok();

        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::stop_being_default_pdf_reader().map_err(PdfError::from)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(desktop_path) = desktop_file_path() {
            if desktop_path.exists() {
                std::fs::remove_file(&desktop_path).map_err(|e| e.to_string())?;
            }
        }
        if let Some(mimeapps) = mimeapps_list_path() {
            if mimeapps.exists() {
                let content = std::fs::read_to_string(&mimeapps).map_err(|e| e.to_string())?;
                let updated = strip_ezreader_from_mimeapps(&content);
                if updated != content {
                    std::fs::write(&mimeapps, updated).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn register_print_verb() -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        if is_packaged() {
            return Ok(());
        }
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();

        let exe_name = std::path::Path::new(&exe)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "ezreader.exe".to_string());

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (progid_print, _) =
            hkcu.create_subkey(r"Software\Classes\com.ezreader.app\shell\print\command").map_err(|e| e.to_string())?;
        progid_print.set_value("", &format!("\"{exe}\" --print \"%1\"")).map_err(|e| e.to_string())?;

        let (app_key, _) =
            hkcu.create_subkey(format!(r"Software\Classes\Applications\{exe_name}")).map_err(|e| e.to_string())?;
        app_key.set_value("NoOpenWith", &"").map_err(|e| e.to_string())?;
        let (app_print, _) = app_key.create_subkey(r"shell\print\command").map_err(|e| e.to_string())?;
        app_print.set_value("", &format!("\"{exe}\" --print \"%1\"")).map_err(|e| e.to_string())?;

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

fn web_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let s = url.as_str();
    if s.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"') {
        return None;
    }
    Some(s.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> CmdResult<()> {
    let Some(url) = web_url(&url) else {
        return Err("Only http/https web addresses can be opened".into());
    };
    #[cfg(target_os = "windows")]
    {
        use winapi::um::shellapi::ShellExecuteW;
        use winapi::um::winuser::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (verb, target) = (wide("open"), wide(&url));
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if code <= 32 {
            return Err(format!("could not open the link (error {code})").into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener).arg(&url).spawn().map_err(|e| format!("could not open the link ({e})"))?;
        Ok(())
    }
}

#[cfg(test)]
mod url_tests {
    use super::web_url;

    #[test]
    fn plain_web_links_open() {
        assert_eq!(web_url("https://example.com/a b?q=\"x\"").as_deref(), Some("https://example.com/a%20b?q=%22x%22"));
        assert_eq!(web_url(" http://example.com ").as_deref(), Some("http://example.com/"));
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://bank.example@evil.example/",
            "https://",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            assert_eq!(web_url(bad), None, "{bad}");
        }
    }
}

#[tauri::command]
pub async fn open_default_apps_settings() -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        if is_windows_10() {
            let picked = tauri::async_runtime::spawn_blocking(show_pdf_open_with_picker).await.unwrap_or(Err(0));
            match picked {
                Ok(()) => return Ok(()),
                Err(code) if code == ERROR_CANCELLED_HRESULT => return Ok(()),
                Err(_) => {}
            }
        }
        let family = std::env::current_exe().ok().and_then(|p| package_family_from_exe(&p.to_string_lossy()));
        let uri = default_apps_uri(family.as_deref());
        Command::new("cmd").args(["/C", "start", "", &uri]).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
const CAPABILITIES_KEY: &str = r"Software\EzReader\Capabilities";
#[cfg(target_os = "windows")]
const REGISTERED_APP_NAME: &str = "EzReader";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn default_apps_uri(package_family: Option<&str>) -> String {
    match package_family {
        Some(family) => format!("ms-settings:defaultapps?registeredAUMID={family}!App"),
        None => "ms-settings:defaultapps?registeredAppUser=EzReader".to_string(),
    }
}

#[cfg(target_os = "windows")]
const ERROR_CANCELLED_HRESULT: i32 = 0x8007_04C7_u32 as i32;

#[cfg(target_os = "windows")]
fn is_windows_10() -> bool {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|k| k.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|b| b.trim().parse::<u32>().ok())
        .is_some_and(is_windows_10_build)
}

#[cfg(any(target_os = "windows", test))]
fn is_windows_10_build(build: u32) -> bool {
    (10240..22000).contains(&build)
}

#[cfg(target_os = "windows")]
fn show_pdf_open_with_picker() -> Result<(), i32> {
    use windows::core::w;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        SHOpenWithDialog, OAIF_ALLOW_REGISTRATION, OAIF_FORCE_REGISTRATION, OAIF_REGISTER_EXT, OPENASINFO,
    };

    std::thread::spawn(|| unsafe {
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let info = OPENASINFO {
            pcszFile: w!("document.pdf"),
            pcszClass: windows::core::PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_FORCE_REGISTRATION,
        };
        let res = SHOpenWithDialog(None, &info).map_err(|e| e.code().0);
        if com.is_ok() {
            CoUninitialize();
        }
        res
    })
    .join()
    .unwrap_or(Err(0))
}

#[cfg(test)]
mod windows_version_tests {
    use super::{default_apps_uri, is_windows_10_build};

    #[test]
    fn default_apps_opens_on_ezreader_page() {
        assert_eq!(default_apps_uri(None), "ms-settings:defaultapps?registeredAppUser=EzReader");
        assert_eq!(
            default_apps_uri(Some("alxbdn.EzReader_abc123")),
            "ms-settings:defaultapps?registeredAUMID=alxbdn.EzReader_abc123!App"
        );
    }

    #[test]
    fn windows_10_builds_are_told_apart_from_windows_11() {
        assert!(is_windows_10_build(19045));
        assert!(is_windows_10_build(10240));
        assert!(!is_windows_10_build(22000));
        assert!(!is_windows_10_build(26100));
        assert!(!is_windows_10_build(9600));
    }
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookState {
    available: bool,
    enabled: bool,
}

#[cfg(target_os = "windows")]
mod quick_look {
    use std::path::PathBuf;

    pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    pub const RUN_VALUE: &str = "EzReader Quick Look";
    pub const TASK_ID: &str = "QuickLook";

    pub fn helper() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let helper = exe.parent()?.join("ezreader-quicklook.exe");
        helper.is_file().then_some(helper)
    }

    fn startup_task() -> Result<windows::ApplicationModel::StartupTask, String> {
        windows::ApplicationModel::StartupTask::GetAsync(&windows::core::HSTRING::from(TASK_ID))
            .and_then(|op| op.join())
            .map_err(|e| e.message())
    }

    pub fn enabled() -> bool {
        use windows::ApplicationModel::StartupTaskState;
        if super::is_packaged() {
            return startup_task()
                .and_then(|t| t.State().map_err(|e| e.message()))
                .is_ok_and(|s| s == StartupTaskState::Enabled || s == StartupTaskState::EnabledByPolicy);
        }
        use winreg::enums::HKEY_CURRENT_USER;
        winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
            .is_ok()
    }

    /// An update stops the helper, and Windows only starts it again at the
    /// next sign-in; older installers also dropped its startup entry. So at
    /// launch: start it if quick look is on, and turn it back on if it was on
    /// before an update. A second copy exits at once (single-instance mutex).
    pub fn resume(memo: &std::path::Path, version: &str) {
        let Some(helper) = helper() else { return };
        let remembered = std::fs::read_to_string(memo).ok();
        match super::quick_look_after_launch(enabled(), remembered.as_deref(), version) {
            super::QuickLookResume::Start => {
                let _ = std::process::Command::new(&helper).spawn();
                let _ = std::fs::write(memo, version);
            }
            super::QuickLookResume::TurnBackOn => {
                if set(true, &helper).is_ok() {
                    let _ = std::fs::write(memo, version);
                }
            }
            super::QuickLookResume::Forget => {
                let _ = std::fs::remove_file(memo);
            }
            super::QuickLookResume::Nothing => {}
        }
    }

    pub fn set(enabled: bool, helper: &std::path::Path) -> Result<(), String> {
        use windows::ApplicationModel::StartupTaskState;
        if super::is_packaged() {
            let task = startup_task()?;
            if enabled {
                let state = task.RequestEnableAsync().and_then(|op| op.join()).map_err(|e| e.message())?;
                if state != StartupTaskState::Enabled && state != StartupTaskState::EnabledByPolicy {
                    return Err("startup-blocked".into());
                }
            } else {
                task.Disable().map_err(|e| e.message())?;
            }
        } else {
            use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
            let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
            let (run, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
            if enabled {
                run.set_value(RUN_VALUE, &format!("\"{}\"", helper.display())).map_err(|e| e.to_string())?;
            } else if let Ok(run) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
                let _ = run.delete_value(RUN_VALUE);
            }
        }
        let mut command = std::process::Command::new(helper);
        if !enabled {
            command.arg("--stop");
        }
        command.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum QuickLookResume {
    /// On: make sure the helper runs.
    Start,
    /// Was on before an update that turned it off: turn it on again.
    TurnBackOn,
    /// Turned off outside EzReader (Task Manager › Startup apps): respect it.
    Forget,
    Nothing,
}

/// `remembered` is the version written when quick look was last seen on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn quick_look_after_launch(enabled: bool, remembered: Option<&str>, version: &str) -> QuickLookResume {
    match (enabled, remembered.map(str::trim)) {
        (true, _) => QuickLookResume::Start,
        (false, Some(v)) if v != version => QuickLookResume::TurnBackOn,
        (false, Some(_)) => QuickLookResume::Forget,
        (false, None) => QuickLookResume::Nothing,
    }
}

#[cfg(target_os = "windows")]
fn quick_look_memo(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("quick-look-on"))
}

/// Called at launch: keeps quick look with Space working after an update.
pub fn resume_quick_look(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    if let Some(memo) = quick_look_memo(&app) {
        quick_look::resume(&memo, &app.package_info().version.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[tauri::command]
pub fn quick_look_state() -> QuickLookState {
    #[cfg(target_os = "windows")]
    {
        if quick_look::helper().is_some() {
            return QuickLookState { available: true, enabled: quick_look::enabled() };
        }
    }
    QuickLookState::default()
}

#[tauri::command]
pub fn set_quick_look(app: tauri::AppHandle, enabled: bool) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        let helper = quick_look::helper().ok_or("quick-look-missing")?;
        quick_look::set(enabled, &helper)?;
        if let Some(memo) = quick_look_memo(&app) {
            if enabled {
                let _ = std::fs::write(&memo, app.package_info().version.to_string());
            } else {
                let _ = std::fs::remove_file(&memo);
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, enabled);
        Err("quick-look-missing".into())
    }
}

#[cfg(test)]
mod quick_look_tests {
    use super::{quick_look_after_launch, QuickLookResume};

    #[test]
    fn quick_look_comes_back_after_an_update() {
        assert_eq!(quick_look_after_launch(true, None, "1.2.0"), QuickLookResume::Start);
        assert_eq!(quick_look_after_launch(true, Some("1.1.0"), "1.2.0"), QuickLookResume::Start);
        assert_eq!(quick_look_after_launch(false, Some("1.1.0\n"), "1.2.0"), QuickLookResume::TurnBackOn);
    }

    #[test]
    fn quick_look_stays_off_when_turned_off() {
        assert_eq!(quick_look_after_launch(false, Some("1.2.0"), "1.2.0"), QuickLookResume::Forget);
        assert_eq!(quick_look_after_launch(false, None, "1.2.0"), QuickLookResume::Nothing);
    }
}
