#[cfg(windows)]
fn set_strip_visible(hwnd: isize, visible: bool) {
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{FindWindowExW, ShowWindow, SW_HIDE, SW_SHOWNA};

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let class = wide("TAURI_DRAG_RESIZE_BORDERS");
    let name = wide("TAURI_DRAG_RESIZE_WINDOW");
    unsafe {
        let strip = FindWindowExW(hwnd as HWND, std::ptr::null_mut(), class.as_ptr(), name.as_ptr());
        if !strip.is_null() {
            ShowWindow(strip, if visible { SW_SHOWNA } else { SW_HIDE });
        }
    }
}

#[tauri::command]
pub fn set_resize_border(window: tauri::WebviewWindow, visible: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        set_strip_visible(hwnd.0 as isize, visible);
    }
    #[cfg(not(windows))]
    let _ = (window, visible);
}
