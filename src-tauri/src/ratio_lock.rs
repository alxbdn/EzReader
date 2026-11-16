//! The launcher keeps its proportions while the user resizes it; once a
//! document is open the window is free (it takes the shape of a page, see
//! src/window-fit.ts). Windows sends WM_SIZING with the rectangle the drag
//! asks for, before applying it: the lock corrects that rectangle, so the
//! window never shows the wrong shape, not even for a frame.
//!
//! The same hook keeps the size of a window that Windows snapped (stretched
//! to full height, or to a side): moving it afterwards no longer brings
//! back the size it had before the snap.
//!
//! On macOS AppKit keeps the proportions itself (see `macos.rs`).

// The geometry below is only used by the Windows hook (and the tests).
#![cfg_attr(not(windows), allow(dead_code))]

/// Which edge or corner is dragged (the WMSZ_* values).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Edge {
    Left,
    Right,
    Top,
    TopLeft,
    TopRight,
    Bottom,
    BottomLeft,
    BottomRight,
}

impl Edge {
    pub fn from_wmsz(v: usize) -> Option<Edge> {
        Some(match v {
            1 => Edge::Left,
            2 => Edge::Right,
            3 => Edge::Top,
            4 => Edge::TopLeft,
            5 => Edge::TopRight,
            6 => Edge::Bottom,
            7 => Edge::BottomLeft,
            8 => Edge::BottomRight,
            _ => return None,
        })
    }
}

/// Window rectangle, in physical pixels (left, top, right, bottom).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/**
 * `r` (asked for by dragging `edge`) changed to `ratio` (width / height),
 * at least `min_w` × `min_h`. A side edge drives the width, the top or
 * bottom edge the height, a corner whichever moved more; the edge opposite
 * the one dragged stays where it is.
 */
pub fn constrain(r: Rect, edge: Edge, ratio: f64, min_w: i32, min_h: i32, before: Rect) -> Rect {
    if ratio.is_nan() || ratio <= 0.0 {
        return r;
    }
    let mut w = (r.right - r.left) as f64;
    let mut h = (r.bottom - r.top) as f64;
    let width_drives = match edge {
        Edge::Left | Edge::Right => true,
        Edge::Top | Edge::Bottom => false,
        _ => {
            let dw = (w - (before.right - before.left) as f64).abs();
            let dh = (h - (before.bottom - before.top) as f64).abs();
            dw / ratio >= dh
        }
    };
    if width_drives {
        h = w / ratio;
    } else {
        w = h * ratio;
    }
    // Never smaller than the minimum size, still with the same shape.
    let grow = (min_w as f64 / w).max(min_h as f64 / h).max(1.0);
    let (w, h) = ((w * grow).round() as i32, (h * grow).round() as i32);

    let mut out = r;
    match edge {
        Edge::Left | Edge::TopLeft | Edge::BottomLeft => out.left = r.right - w,
        _ => out.right = r.left + w,
    }
    match edge {
        Edge::Top | Edge::TopLeft | Edge::TopRight => out.top = r.bottom - h,
        _ => out.bottom = r.top + h,
    }
    out
}

#[cfg(windows)]
mod win {
    use super::{constrain, Edge, Rect};
    use winapi::shared::basetsd::{DWORD_PTR, UINT_PTR};
    use winapi::shared::minwindef::{BOOL, LPARAM, LRESULT, TRUE, UINT, WPARAM};
    use winapi::shared::windef::{HWND, RECT};
    use winapi::um::commctrl::{DefSubclassProc, SetWindowSubclass};
    use winapi::um::libloaderapi::{GetModuleHandleA, GetProcAddress};
    use winapi::um::winuser::{
        GetDpiForWindow, GetMonitorInfoW, GetWindowPlacement, GetWindowRect, IsIconic, IsZoomed, MonitorFromWindow,
        PostMessageW, SetWindowPlacement, MONITORINFO, MONITOR_DEFAULTTONEAREST, SW_SHOWNORMAL, WINDOWPLACEMENT,
        WM_APP, WM_SIZING, WM_WINDOWPOSCHANGED,
    };

    const SUBCLASS_ID: UINT_PTR = 0x457a_5274; // "EzRt"

    /// Posted to itself once Windows snapped the window (see `unsnap`).
    const WM_EZ_UNSNAP: UINT = WM_APP + 0x45;

    thread_local! {
        /// Unsnaps asked for since the window was last seen not snapped.
        static TRIES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }

    /// Smallest window, as in tauri.conf.json (logical pixels).
    const MIN_W: f64 = 720.0;
    const MIN_H: f64 = 480.0;

    /// `IsWindowArranged` (user32, Windows 10 and later): true while the
    /// window is snapped (to a side, a corner, or stretched to full height).
    unsafe fn is_arranged(hwnd: HWND) -> bool {
        type IsWindowArranged = unsafe extern "system" fn(HWND) -> BOOL;
        let user32 = GetModuleHandleA(c"user32.dll".as_ptr());
        if user32.is_null() {
            return false;
        }
        let f = GetProcAddress(user32, c"IsWindowArranged".as_ptr());
        if f.is_null() {
            return false;
        }
        let f: IsWindowArranged = std::mem::transmute(f);
        f(hwnd) != 0
    }

    /**
     * A snapped window becomes a normal window of the same size and place.
     * Windows otherwise keeps the size from before the snap and puts it back
     * as soon as the window is dragged: stretched to full height, it shrank
     * again when moved.
     */
    unsafe fn unsnap(hwnd: HWND) {
        if !is_arranged(hwnd) || IsZoomed(hwnd) != 0 || IsIconic(hwnd) != 0 {
            return;
        }
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return;
        }
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as UINT;
        if GetWindowPlacement(hwnd, &mut wp) == 0 {
            return;
        }
        // The placement counts from the work area, not from the screen.
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let (dx, dy) = if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi) != 0 {
            (mi.rcWork.left - mi.rcMonitor.left, mi.rcWork.top - mi.rcMonitor.top)
        } else {
            (0, 0)
        };
        wp.showCmd = SW_SHOWNORMAL as UINT;
        wp.rcNormalPosition = RECT { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy };
        SetWindowPlacement(hwnd, &wp);
    }

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: UINT,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: UINT_PTR,
        data: DWORD_PTR,
    ) -> LRESULT {
        // `data`: the locked width / height (as f64 bits), 0 when free.
        if msg == WM_SIZING && lparam != 0 && data != 0 {
            if let Some(edge) = Edge::from_wmsz(wparam) {
                let ratio = f64::from_bits(data as u64);
                let rect = &mut *(lparam as *mut RECT);
                let mut now: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut now);
                let dpi = GetDpiForWindow(hwnd);
                let k = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
                let r = constrain(
                    Rect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
                    edge,
                    ratio,
                    (MIN_W * k).round() as i32,
                    (MIN_H * k).round() as i32,
                    Rect { left: now.left, top: now.top, right: now.right, bottom: now.bottom },
                );
                rect.left = r.left;
                rect.top = r.top;
                rect.right = r.right;
                rect.bottom = r.bottom;
                // Let the rest of the chain see the corrected rectangle too.
                DefSubclassProc(hwnd, msg, wparam, lparam);
                return TRUE as LRESULT;
            }
        }
        if msg == WM_WINDOWPOSCHANGED {
            if !is_arranged(hwnd) {
                TRIES.with(|t| t.set(0));
            } else if IsZoomed(hwnd) == 0 && TRIES.with(|t| t.get()) < 2 {
                // Not from inside the snap itself: once it is over. Tried
                // twice at most, should a Windows version refuse it.
                TRIES.with(|t| t.set(t.get() + 1));
                PostMessageW(hwnd, WM_EZ_UNSNAP, 0, 0);
            }
        }
        if msg == WM_EZ_UNSNAP {
            unsnap(hwnd);
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// Locks `hwnd` to its present proportions, or frees it. Either way, a
    /// snap keeps its size when the window is moved afterwards.
    pub fn set(hwnd: isize, locked: bool) {
        let hwnd = hwnd as HWND;
        unsafe {
            let mut ratio = 0.0f64;
            if locked {
                let mut r: RECT = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut r) != 0 && r.bottom > r.top {
                    ratio = (r.right - r.left) as f64 / (r.bottom - r.top) as f64;
                }
            }
            let data = if ratio > 0.0 { ratio.to_bits() as DWORD_PTR } else { 0 };
            // Installs the hook, or only updates its data when already there.
            SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, data);
        }
    }
}

/// Locks the window's present proportions (`locked`), or frees them.
pub fn set_ratio_lock(window: &tauri::WebviewWindow, locked: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        win::set(hwnd.0 as isize, locked);
    }
    #[cfg(target_os = "macos")]
    crate::macos::set_ratio_lock(window, locked);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (window, locked);
}

/// Keeps the launcher's proportions while it is resized (`locked`), or
/// frees them once a document is open.
#[tauri::command]
pub fn set_launcher_ratio_lock(window: tauri::WebviewWindow, locked: bool) {
    set_ratio_lock(&window, locked);
}

#[cfg(test)]
mod tests {
    use super::*;

    const R43: f64 = 4.0 / 3.0;
    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rect {
        Rect { left: l, top: t, right: r, bottom: b }
    }
    const BEFORE: Rect = Rect { left: 0, top: 0, right: 800, bottom: 600 };

    #[test]
    fn dragging_the_right_edge_sets_the_height() {
        let r = constrain(rect(0, 0, 1000, 600), Edge::Right, R43, 0, 0, BEFORE);
        assert_eq!(r, rect(0, 0, 1000, 750));
    }

    #[test]
    fn dragging_the_top_edge_sets_the_width_and_keeps_the_bottom() {
        let r = constrain(rect(0, -150, 800, 600), Edge::Top, R43, 0, 0, BEFORE);
        assert_eq!(r, rect(0, -150, 1000, 600));
    }

    #[test]
    fn a_top_left_corner_keeps_the_bottom_right_corner() {
        let r = constrain(rect(-200, -10, 800, 600), Edge::TopLeft, R43, 0, 0, BEFORE);
        assert_eq!(r, rect(-200, -150, 800, 600));
    }

    #[test]
    fn the_minimum_size_keeps_the_shape() {
        let r = constrain(rect(0, 0, 300, 600), Edge::Right, R43, 720, 480, BEFORE);
        assert_eq!(r, rect(0, 0, 720, 540));
    }

    #[test]
    fn a_bad_ratio_leaves_the_rectangle() {
        let r = constrain(rect(0, 0, 300, 600), Edge::Right, 0.0, 720, 480, BEFORE);
        assert_eq!(r, rect(0, 0, 300, 600));
    }
}
