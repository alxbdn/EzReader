use crate::error::CmdResult;

#[cfg(target_os = "windows")]
use super::shell::is_packaged;
use super::shell::off_main_thread;

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
pub async fn check_pdf_association() -> bool {
    off_main_thread(pdf_association).await
}

fn pdf_association() -> bool {
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
        let Ok(out) = std::process::Command::new("xdg-mime").args(["query", "default", "application/pdf"]).output()
        else {
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
pub async fn is_default_pdf_reader() -> bool {
    off_main_thread(default_pdf_reader).await
}

fn default_pdf_reader() -> bool {
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
        pdf_association()
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
        crate::macos::make_default_pdf_reader().map_err(crate::error::PdfError::from)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let desktop_path = desktop_file_path()
            .ok_or_else(|| crate::error::PdfError::from("Could not locate applications directory"))?;
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

        let status = std::process::Command::new("xdg-mime")
            .args(["default", "ezreader.desktop", "application/pdf"])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("xdg-mime failed to set application/pdf default".into());
        }
        Ok(())
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
        crate::macos::stop_being_default_pdf_reader().map_err(crate::error::PdfError::from)
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
        std::process::Command::new("cmd").args(["/C", "start", "", &uri]).spawn().map_err(|e| e.to_string())?;
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
pub(crate) fn is_windows_10() -> bool {
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

#[cfg(test)]
#[cfg(not(windows))]
mod mimeapps_tests {
    #[test]
    fn strips_ezreader_from_mimeapps() {
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
}
