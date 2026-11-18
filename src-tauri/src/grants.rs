use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::error::{CmdResult, ErrorCode, PdfError};

#[derive(Default)]
pub struct Grants {
    files: Mutex<HashSet<String>>,
    dirs: Mutex<HashSet<String>>,
}

static GRANTS: LazyLock<Grants> = LazyLock::new(Grants::default);

fn key(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        match c {
            Component::Prefix(p) => parts.push(p.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir => {}
            Component::CurDir => {}
            Component::ParentDir => return None,
            Component::Normal(n) => parts.push(n.to_string_lossy().into_owned()),
        }
    }
    let joined = parts.join("/");
    Some(if cfg!(windows) { joined.to_lowercase() } else { joined })
}

fn plain_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.contains([':', '/', '\\'])
}

impl Grants {
    fn allow_file(&self, path: &Path) {
        if let Some(k) = key(path) {
            self.files.lock().unwrap().insert(k);
        }
    }

    fn allow_dir(&self, path: &Path) {
        if let Some(k) = key(path) {
            self.dirs.lock().unwrap().insert(k);
        }
    }

    fn file_granted(&self, path: &Path) -> bool {
        key(path).is_some_and(|k| self.files.lock().unwrap().contains(&k))
    }

    fn dir_granted(&self, path: &Path) -> bool {
        key(path).is_some_and(|k| self.dirs.lock().unwrap().contains(&k))
    }

    fn allows(&self, path: &Path, temp: &Path) -> bool {
        if self.file_granted(path) {
            return true;
        }
        let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
            return false;
        };
        if !plain_name(name) {
            return false;
        }
        if self.dir_granted(parent) {
            return true;
        }
        let same = |a: &Path, b: &Path| key(a).is_some() && key(a) == key(b);
        if name.starts_with("ezreader-") && same(parent, temp) {
            return true;
        }
        let in_window_dir =
            parent.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("ezreader-window-"));
        in_window_dir && parent.parent().is_some_and(|p| same(p, temp))
    }

    fn check(&self, path: &str, temp: &Path) -> CmdResult<()> {
        if self.allows(Path::new(path), temp) {
            Ok(())
        } else {
            Err(PdfError::new(ErrorCode::NotAllowed, format!("not a file you opened or chose: {path}")))
        }
    }
}

pub fn allow_file(path: &str) {
    GRANTS.allow_file(Path::new(path));
}

pub fn allow_dir(path: &str) {
    GRANTS.allow_dir(Path::new(path));
}

pub fn is_granted_file(path: &str) -> bool {
    GRANTS.file_granted(Path::new(path))
}

pub fn check(path: &str) -> CmdResult<()> {
    if cfg!(test) {
        return Ok(());
    }
    GRANTS.check(path, &std::env::temp_dir())
}

pub fn check_dir(path: &str) -> CmdResult<()> {
    if cfg!(test) || GRANTS.dir_granted(Path::new(path)) {
        return Ok(());
    }
    Err(PdfError::new(ErrorCode::NotAllowed, format!("not a folder you chose: {path}")))
}

pub fn check_all<'a>(paths: impl IntoIterator<Item = &'a String>) -> CmdResult<()> {
    paths.into_iter().try_for_each(|p| check(p))
}

pub fn absolute(path: &str) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\me")
        } else {
            PathBuf::from("/home/me")
        }
    }

    fn temp() -> PathBuf {
        root().join("AppData").join("Local").join("Temp")
    }

    #[test]
    fn only_picked_files_and_folders_are_allowed() {
        let g = Grants::default();
        let doc = root().join("Docs").join("contrat.pdf");
        let out = root().join("Export");
        g.allow_file(&doc);
        g.allow_dir(&out);

        assert!(g.allows(&doc, &temp()));
        assert!(g.allows(&out.join("contrat-1.png"), &temp()));
        assert!(!g.allows(&out.join("sub").join("x.png"), &temp()));
        assert!(!g.allows(&root().join("Docs").join("other.pdf"), &temp()));
        let startup = root()
            .join("AppData")
            .join("Roaming")
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join("x.bat");
        assert!(!g.allows(&startup, &temp()));
    }

    #[test]
    fn tricks_do_not_get_through() {
        let g = Grants::default();
        let out = root().join("Export");
        g.allow_dir(&out);
        assert!(!g.allows(&out.join("..").join("secret.txt"), &temp()), "no climbing out");
        assert!(!g.allows(Path::new("relative.pdf"), &temp()), "no relative paths");
        assert!(!g.allows(&out.join("a.png:hidden"), &temp()), "no alternate streams");
    }

    #[test]
    fn the_apps_temp_files_are_allowed() {
        let g = Grants::default();
        assert!(g.allows(&temp().join("ezreader-p12-x-display-a.pdf"), &temp()));
        assert!(g.allows(&temp().join("ezreader-window-12-1").join("Pages.pdf"), &temp()));
        assert!(!g.allows(&temp().join("other.pdf"), &temp()));
        assert!(!g.allows(&temp().join("sub").join("ezreader-x.pdf"), &temp()));
    }

    use proptest::prelude::*;

    fn segment() -> impl Strategy<Value = String> {
        prop_oneof![
            "[a-zA-Z0-9 _.-]{1,12}",
            Just("..".to_string()),
            Just(".".to_string()),
            "[a-z]{1,6}:[a-z]{0,6}",
            "[a-z]{1,6}[/\\\\][a-z]{1,6}",
        ]
    }

    proptest! {
        #[test]
        fn nothing_escapes_a_picked_folder(parts in prop::collection::vec(segment(), 1..5)) {
            let g = Grants::default();
            let out = root().join("Export");
            g.allow_dir(&out);
            let mut p = out.clone();
            for part in &parts {
                p.push(part);
            }
            if g.allows(&p, &temp()) {
                prop_assert_eq!(p.parent(), Some(out.as_path()), "{:?} got out of the folder", p);
                let name = p.file_name().unwrap().to_str().unwrap();
                prop_assert!(plain_name(name));
                prop_assert!(!p.components().any(|c| c == Component::ParentDir));
            }
        }

        #[test]
        fn relative_paths_are_refused(parts in prop::collection::vec(segment(), 1..5)) {
            let g = Grants::default();
            let rel: PathBuf = parts.iter().collect();
            g.allow_file(&rel);
            prop_assert!(!g.allows(&rel, &temp()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_ignore_case_and_separators() {
        let g = Grants::default();
        g.allow_file(Path::new(r"C:\Users\me\Docs\Contrat.pdf"));
        assert!(g.allows(Path::new("c:/users/ME/docs/contrat.PDF"), &temp()));
    }
}
