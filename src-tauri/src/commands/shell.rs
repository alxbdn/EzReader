use crate::error::CmdResult;
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
pub(crate) fn is_packaged() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_ascii_lowercase().contains(r"\windowsapps\"))
        .unwrap_or(false)
}

pub(crate) async fn off_main_thread<T: Send + Default + 'static>(probe: fn() -> T) -> T {
    tauri::async_runtime::spawn_blocking(probe).await.unwrap_or_default()
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
        std::process::Command::new(opener).arg(&url).spawn().map_err(|e| format!("could not open the link ({e})"))?;
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
