//! Full screen and the window's invisible resize border.
//!
//! The window has no system frame (decorations: false), so Tauri puts a
//! child window of its own over the page, cut down to a strip a few pixels
//! high along the top edge: grabbing it resizes the window. Tauri hides that
//! strip while the window is maximized, but not in full screen. There the
//! window loses its sizing border, the strip stops passing the pointer on as
//! a resize edge and simply sits over the menu row: every time the pointer
//! crosses the top edge of the screen it leaves the page (hover effects go
//! off and on, the pointer shape jumps) and a click on a menu there is lost.
//!
//! The strip is hidden for as long as full screen lasts. Tauri only moves
//! and resizes it afterwards, it never shows it again on its own.

#[cfg(windows)]
fn set_strip_visible(hwnd: isize, visible: bool) {
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{FindWindowExW, ShowWindow, SW_HIDE, SW_SHOWNA};

    // Class and window name of Tauri's strip (tauri-runtime-wry,
    // undecorated_resizing.rs).
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

/// Hides the resize strip on the top edge (`visible` false, entering full
/// screen) or shows it again (leaving full screen).
#[tauri::command]
pub fn set_resize_border(window: tauri::WebviewWindow, visible: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        set_strip_visible(hwnd.0 as isize, visible);
    }
    #[cfg(not(windows))]
    let _ = (window, visible);
}
