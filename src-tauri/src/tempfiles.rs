//! The app's temp files: working copies of open documents, unlocked copies
//! of password-protected ones, pages dragged out to a new window.
//!
//! They hold the document's content, sometimes without its password or
//! with text that a redaction removed, so none may outlive the app. Each
//! file is named after the process that made it (`ezreader-p<pid>-…`): the
//! app removes its own on exit, and at startup removes those of processes
//! that are gone (a crash, a forced shutdown).

use std::path::Path;
use std::time::{Duration, SystemTime};

/// What every temp file of this process starts with, after `ezreader-`.
pub fn tag() -> String {
    format!("p{}", std::process::id())
}

/// Files from before temp names carried a process id are removed once
/// they are this old: by then no running app still uses them.
const LEGACY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The process that owns the temp entry `name`, when its name says so.
/// `None` for a name of an older version (or not an EzReader name).
fn owner(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ezreader-")?;
    let digits = rest
        .strip_prefix('p')
        .or_else(|| rest.strip_prefix("window-"))?;
    let end = digits.find('-')?;
    digits[..end].parse().ok()
}

/// Removes the EzReader temp entries in `dir` that `stale` says no running
/// app can still be using. Errors are ignored: a file that cannot be
/// removed now is tried again at the next start.
fn sweep_with(dir: &Path, stale: impl Fn(&str, Option<SystemTime>) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("ezreader-") {
            continue;
        }
        let modified = entry.metadata().and_then(|m| m.modified()).ok();
        if !stale(&name, modified) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// At startup: removes the temp files of EzReader processes that are no
/// longer running, and old files from versions before this naming.
pub fn sweep_leftovers() {
    let me = std::process::id();
    let now = SystemTime::now();
    sweep_with(&std::env::temp_dir(), |name, modified| match owner(name) {
        Some(pid) => pid != me && !is_running(pid),
        None => modified
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > LEGACY_MAX_AGE),
    });
}

/// On exit: removes every temp file this process made.
pub fn remove_own() {
    let me = std::process::id();
    sweep_with(&std::env::temp_dir(), |name, _| owner(name) == Some(me));
}

#[cfg(windows)]
fn is_running(pid: u32) -> bool {
    use winapi::shared::minwindef::FALSE;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::minwinbase::STILL_ACTIVE;
    use winapi::um::processthreadsapi::{GetExitCodeProcess, OpenProcess};
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    // SAFETY: plain Win32 calls; the handle is checked and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            // No such process, or one we may not look at (another user's):
            // only a process that is gone is treated as gone.
            return winapi::um::errhandlingapi::GetLastError() != winapi::shared::winerror::ERROR_INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn is_running(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owners_are_read_from_names() {
        assert_eq!(owner("ezreader-p1234-lx2k-3-display-a.pdf"), Some(1234));
        assert_eq!(owner("ezreader-window-88-2"), Some(88));
        assert_eq!(owner("ezreader-lx2k-3-display-a.pdf"), None);
        assert_eq!(owner("ezreader-pages-x.pdf"), None);
        assert_eq!(owner("other-p12-x"), None);
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ezr-sweep-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sweeping_removes_only_what_is_stale() {
        let d = dir("stale");
        for f in ["ezreader-p1-a.pdf", "ezreader-p2-b.pdf", "notes.txt"] {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        std::fs::create_dir(d.join("ezreader-window-1-1")).unwrap();
        std::fs::write(d.join("ezreader-window-1-1").join("Pages.pdf"), b"x").unwrap();

        sweep_with(&d, |name, _| owner(name) == Some(1));

        let mut left: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["ezreader-p2-b.pdf", "notes.txt"]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn this_process_is_running() {
        assert!(is_running(std::process::id()));
    }

    #[test]
    fn the_tag_names_this_process() {
        assert_eq!(owner(&format!("ezreader-{}-x.pdf", tag())), Some(std::process::id()));
    }
}
