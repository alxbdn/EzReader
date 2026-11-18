use std::path::Path;
use std::time::{Duration, SystemTime};

pub fn tag() -> String {
    format!("p{}", std::process::id())
}

const LEGACY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn owner(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ezreader-")?;
    let digits =
        rest.strip_prefix('p').or_else(|| rest.strip_prefix("window-new-")).or_else(|| rest.strip_prefix("window-"))?;
    let end = digits.find('-')?;
    digits[..end].parse().ok()
}

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

pub fn sweep_leftovers() {
    let me = std::process::id();
    let now = SystemTime::now();
    sweep_with(&std::env::temp_dir(), |name, modified| match owner(name) {
        Some(pid) => pid != me && !is_running(pid),
        None => modified.and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > LEGACY_MAX_AGE),
    });
}

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
            return winapi::um::errhandlingapi::GetLastError() != winapi::shared::winerror::ERROR_INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE
    }
}

#[cfg(target_os = "linux")]
fn is_running(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_running(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const EPERM: i32 = 1;
    let Ok(pid) = i32::try_from(pid) else { return false };
    // SAFETY: signal 0 sends nothing, it only checks the pid.
    let alive = unsafe { kill(pid, 0) == 0 };
    alive || std::io::Error::last_os_error().raw_os_error() == Some(EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owners_are_read_from_names() {
        assert_eq!(owner("ezreader-p1234-lx2k-3-display-a.pdf"), Some(1234));
        assert_eq!(owner("ezreader-window-88-2"), Some(88));
        assert_eq!(owner("ezreader-window-new-88-2"), Some(88));
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

        let mut left: Vec<_> =
            std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
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
