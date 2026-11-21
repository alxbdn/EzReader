use crate::error::CmdResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const LATEST_URL: &str = "https://api.github.com/repos/alxbdn/EzReader/releases/latest";
const MAC_LATEST_URL: &str = "https://api.github.com/repos/alxbdn/homebrew-ezreader/releases/latest";
const RELEASE_PAGE: &str = "https://github.com/alxbdn/EzReader/releases/latest";
#[cfg(target_os = "windows")]
const STORE_PAGE: &str = "ms-windows-store://pdp/?productid=9P9PVN4DRVS8";
#[cfg(target_os = "macos")]
const BREW_CASK: &str = "alxbdn/ezreader/ezreader";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Store,
    Installer,
    Portable,
    Deb,
    Homebrew,
    Dmg,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    pub up_to_date: bool,
    pub channel: Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateOutcome {
    Restarting,
    Opened,
    OtherWindows,
}

/// What a background check left ready for when EzReader closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Prepared {
    /// Downloaded (or already swapped in): it installs when EzReader closes.
    Ready,
    /// This kind of install cannot update itself silently: keep the button.
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    /// The downloaded installer, run silently when EzReader closes.
    Installer(PathBuf),
    /// The portable file already holds the new version: it starts next time.
    Swapped(PathBuf),
    /// `brew upgrade` runs once EzReader has closed.
    Homebrew,
    /// The downloaded disk image, copied over the app when EzReader closes.
    Dmg(PathBuf),
    /// Downloaded by the Microsoft Store, installed when EzReader closes.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Store,
}

/// The update downloaded at launch, shared by every window.
#[derive(Default)]
pub struct PendingUpdate {
    slot: Mutex<Option<Pending>>,
    /// Held while one window downloads, so a second window does not download again.
    busy: Mutex<()>,
    relaunch: AtomicBool,
}

impl PendingUpdate {
    fn take(&self) -> Option<Pending> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn is_ready(&self) -> bool {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    fn set(&self, pending: Pending) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(pending);
    }
}

#[derive(Debug, Clone, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

fn version_parts(v: &str) -> Vec<u64> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or("");
    core.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (version_parts(latest), version_parts(current));
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

fn pick_asset(assets: &[Asset], channel: Channel, windows: bool) -> Option<&Asset> {
    let wanted = |n: &str| match channel {
        Channel::Installer => n.ends_with("-win-x64-setup.exe"),
        Channel::Portable if windows => n.starts_with("ezreader-portable-") && n.ends_with("-win-x64.exe"),
        Channel::Portable => n.starts_with("ezreader-portable-") && n.ends_with("-linux-x64"),
        Channel::Deb => n.ends_with("_amd64.deb"),
        Channel::Dmg => n.ends_with("-macos-universal.dmg"),
        Channel::Store | Channel::Homebrew | Channel::Other => false,
    };
    assets.iter().find(|a| wanted(&a.name))
}

#[cfg_attr(not(test), allow(dead_code))]
struct InstallFacts<'a> {
    os: &'a str,
    exe: &'a str,
    has_uninstaller: bool,
    in_caskroom: bool,
    appimage: bool,
}

fn classify(f: &InstallFacts) -> Channel {
    let exe = f.exe.replace('\\', "/").to_ascii_lowercase();
    match f.os {
        "windows" if exe.contains("/windowsapps/") => Channel::Store,
        "windows" if f.has_uninstaller => Channel::Installer,
        "windows" => Channel::Portable,
        "macos" if f.in_caskroom => Channel::Homebrew,
        "macos" => Channel::Dmg,
        "linux" if f.appimage => Channel::Other,
        "linux" if exe.starts_with("/usr/") => Channel::Deb,
        "linux" => Channel::Portable,
        _ => Channel::Other,
    }
}

fn current_exe() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|p| p.canonicalize().unwrap_or(p))
}

fn detect_channel() -> Channel {
    let Some(exe) = current_exe() else { return Channel::Other };
    let dir = exe.parent().unwrap_or(Path::new("."));
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    classify(&InstallFacts {
        os,
        exe: &exe.to_string_lossy(),
        has_uninstaller: dir.join("uninstall.exe").exists(),
        in_caskroom: ["/opt/homebrew/Caskroom/ezreader", "/usr/local/Caskroom/ezreader"]
            .iter()
            .any(|p| Path::new(p).exists()),
        appimage: std::env::var_os("APPIMAGE").is_some(),
    })
}

fn quiet(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn curl() -> Command {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        quiet(PathBuf::from(root).join("System32").join("curl.exe"))
    }
    #[cfg(target_os = "macos")]
    {
        quiet("/usr/bin/curl")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        quiet("curl")
    }
}

fn curl_get(version: &str, max_secs: u32) -> Command {
    let mut cmd = curl();
    cmd.args(["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--max-time"])
        .arg(max_secs.to_string())
        .arg("-A")
        .arg(format!("EzReader/{version}"));
    cmd
}

fn latest_url(channel: Channel) -> &'static str {
    match channel {
        Channel::Dmg | Channel::Homebrew => MAC_LATEST_URL,
        _ => LATEST_URL,
    }
}

fn fetch_latest(channel: Channel, version: &str) -> Result<Release, String> {
    let out = curl_get(version, 15)
        .args(["-H", "Accept: application/vnd.github+json", latest_url(channel)])
        .output()
        .map_err(|e| format!("could not run curl ({e})"))?;
    if !out.status.success() {
        return Err(format!("could not reach GitHub ({})", String::from_utf8_lossy(&out.stderr).trim()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("unexpected answer from GitHub ({e})"))
}

fn download(asset: &Asset, dest: &Path, version: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(dest);
    let out = curl_get(version, 900)
        .arg("-o")
        .arg(dest)
        .arg(&asset.browser_download_url)
        .output()
        .map_err(|e| format!("could not run curl ({e})"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(dest);
        return Err(format!("download failed ({})", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let bytes = std::fs::read(dest).map_err(|e| format!("could not read the download ({e})"))?;
    if !digest_matches(&bytes, asset.digest.as_deref()) {
        let _ = std::fs::remove_file(dest);
        return Err("the downloaded file does not match its checksum".into());
    }
    Ok(())
}

fn digest_matches(bytes: &[u8], digest: Option<&str>) -> bool {
    use sha2::{Digest, Sha256};
    let Some(expected) = digest.and_then(|d| d.strip_prefix("sha256:")) else { return false };
    let got: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    got.eq_ignore_ascii_case(expected.trim())
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> CmdResult<UpdateStatus> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let channel = detect_channel();
        let latest = fetch_latest(channel, &current)?;
        let latest_v = latest.tag_name.trim_start_matches(['v', 'V']).to_string();
        Ok(UpdateStatus { up_to_date: !is_newer(&latest_v, &current), latest: latest_v, current, channel })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Called at launch when a newer version is out: downloads it in the
/// background so it installs, without a click, when EzReader closes.
#[tauri::command]
pub async fn prepare_update(app: tauri::AppHandle) -> CmdResult<Prepared> {
    // A development build must never replace itself with a release.
    if cfg!(debug_assertions) {
        return Ok(Prepared::Manual);
    }
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let pending = app.state::<PendingUpdate>();
        let _one_at_a_time = pending.busy.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_ready() {
            return Ok(Prepared::Ready);
        }
        match stage(detect_channel(), &current)? {
            Some(p) => {
                pending.set(p);
                Ok(Prepared::Ready)
            }
            None => Ok(Prepared::Manual),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Channels that can install an update without asking anything.
fn installs_silently(channel: Channel) -> bool {
    matches!(channel, Channel::Installer | Channel::Portable | Channel::Homebrew | Channel::Dmg | Channel::Store)
}

fn stage(channel: Channel, version: &str) -> Result<Option<Pending>, String> {
    if !installs_silently(channel) {
        return Ok(None);
    }
    if channel == Channel::Homebrew {
        return Ok(Some(Pending::Homebrew));
    }
    if channel == Channel::Store {
        // Asks the Store for the newest version straight away, without
        // waiting for the Store's own schedule or for it to be open.
        #[cfg(target_os = "windows")]
        return store::download().map(|ready| ready.then_some(Pending::Store));
        #[cfg(not(target_os = "windows"))]
        return Ok(None);
    }
    let release = fetch_latest(channel, version)?;
    if !is_newer(&release.tag_name, version) {
        return Ok(None);
    }
    let Some(asset) = pick_asset(&release.assets, channel, cfg!(target_os = "windows")) else { return Ok(None) };
    match channel {
        Channel::Portable => swap_self(asset, version).map(|exe| Some(Pending::Swapped(exe))),
        Channel::Installer | Channel::Dmg => {
            let dest = std::env::temp_dir().join(&asset.name);
            download(asset, &dest, version)?;
            Ok(Some(if channel == Channel::Dmg { Pending::Dmg(dest) } else { Pending::Installer(dest) }))
        }
        _ => Ok(None),
    }
}

/// Called when EzReader exits: installs what `prepare_update` downloaded.
pub fn apply_on_exit(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<PendingUpdate>() else { return };
    let Some(pending) = state.take() else { return };
    let _ = apply(pending, state.relaunch.load(Ordering::SeqCst));
}

/// Silent, and run as an update of the installed version.
const SILENT_INSTALLER_ARGS: [&str; 2] = ["/S", "/UPDATE"];

fn apply(pending: Pending, relaunch: bool) -> Result<(), String> {
    match pending {
        Pending::Installer(path) => {
            let args: &[&str] = if relaunch { &INSTALLER_ARGS } else { &SILENT_INSTALLER_ARGS };
            quiet(&path).args(args).spawn().map_err(|e| format!("could not start the installer ({e})"))?;
        }
        Pending::Swapped(exe) => {
            if relaunch {
                quiet(&exe).spawn().map_err(|e| format!("could not restart EzReader ({e})"))?;
            }
        }
        #[cfg(target_os = "macos")]
        Pending::Homebrew => brew_upgrade_after_exit(relaunch)?,
        #[cfg(target_os = "macos")]
        Pending::Dmg(path) => {
            let bundle = replace_bundle(&path)?;
            if relaunch {
                reopen(&bundle)?;
            }
        }
        #[cfg(not(target_os = "macos"))]
        Pending::Homebrew => {}
        #[cfg(not(target_os = "macos"))]
        Pending::Dmg(path) => drop(path),
        #[cfg(target_os = "windows")]
        Pending::Store => store::install(relaunch)?,
        #[cfg(not(target_os = "windows"))]
        Pending::Store => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> CmdResult<UpdateOutcome> {
    let channel = detect_channel();
    let restarts = !matches!(channel, Channel::Store | Channel::Dmg | Channel::Other);
    let ready = app.try_state::<PendingUpdate>().is_some_and(|p| p.is_ready());
    if (restarts || ready) && app.webview_windows().len() > 1 {
        return Ok(UpdateOutcome::OtherWindows);
    }
    if ready {
        // Already downloaded: quit, and the exit hook installs it and restarts.
        app.state::<PendingUpdate>().relaunch.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(UpdateOutcome::Restarting);
    }
    let current = app.package_info().version.to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || run_update(channel, &current))
        .await
        .map_err(|e| e.to_string())??;
    if outcome == UpdateOutcome::Restarting {
        app.exit(0);
    }
    Ok(outcome)
}

/// Passive, restart EzReader after, and run as an update of the installed version.
const INSTALLER_ARGS: [&str; 3] = ["/P", "/R", "/UPDATE"];

fn run_update(channel: Channel, version: &str) -> CmdResult<UpdateOutcome> {
    #[cfg(target_os = "windows")]
    if channel == Channel::Store {
        shell_open(STORE_PAGE)?;
        return Ok(UpdateOutcome::Opened);
    }
    #[cfg(target_os = "macos")]
    if channel == Channel::Homebrew {
        return brew_upgrade();
    }

    let release = fetch_latest(channel, version)?;
    let windows = cfg!(target_os = "windows");
    let Some(asset) = pick_asset(&release.assets, channel, windows) else {
        return open_release_page();
    };

    match channel {
        Channel::Portable => replace_self(asset, version),
        Channel::Installer => {
            let dest = std::env::temp_dir().join(&asset.name);
            download(asset, &dest, version)?;
            // /UPDATE: the old version's uninstaller then knows it is an
            // update and keeps the user's choices (quick look with Space).
            quiet(&dest).args(INSTALLER_ARGS).spawn().map_err(|e| format!("could not start the installer ({e})"))?;
            Ok(UpdateOutcome::Restarting)
        }
        Channel::Deb => install_deb(asset, version),
        Channel::Dmg => {
            let dest = std::env::temp_dir().join(&asset.name);
            download(asset, &dest, version)?;
            shell_open(&dest.to_string_lossy())?;
            Ok(UpdateOutcome::Opened)
        }
        Channel::Store | Channel::Homebrew | Channel::Other => open_release_page(),
    }
}

fn replace_self(asset: &Asset, version: &str) -> CmdResult<UpdateOutcome> {
    let Ok(exe) = swap_self(asset, version) else { return open_release_page() };
    quiet(&exe).spawn().map_err(|e| format!("could not restart EzReader ({e})"))?;
    Ok(UpdateOutcome::Restarting)
}

/// Puts the new portable file in place of this one, which keeps running
/// from its new `.old` name. Returns the path the next launch uses.
fn swap_self(asset: &Asset, version: &str) -> Result<PathBuf, String> {
    let exe = current_exe().ok_or("could not find EzReader's own file")?;
    let new = with_suffix(&exe, ".new");
    let old = with_suffix(&exe, ".old");
    download(asset, &new, version)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(&exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("could not replace EzReader ({e})"));
    }
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe);
        let _ = std::fs::remove_file(&new);
        return Err(format!("could not replace EzReader ({e})"));
    }
    Ok(exe)
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

pub fn remove_leftover() {
    if let Some(exe) = current_exe() {
        let old = with_suffix(&exe, ".old");
        if old.exists() {
            let _ = std::fs::remove_file(old);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn install_deb(asset: &Asset, version: &str) -> CmdResult<UpdateOutcome> {
    let dest = std::env::temp_dir().join(&asset.name);
    download(asset, &dest, version)?;
    let status = Command::new("pkexec").args(["apt-get", "install", "-y"]).arg(&dest).status();
    match status {
        Ok(s) if s.success() => {
            let exe = current_exe().ok_or("could not find EzReader's own file")?;
            Command::new(exe).spawn().map_err(|e| format!("could not restart EzReader ({e})"))?;
            Ok(UpdateOutcome::Restarting)
        }
        _ => {
            shell_open(&dest.to_string_lossy())?;
            Ok(UpdateOutcome::Opened)
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn install_deb(_asset: &Asset, _version: &str) -> CmdResult<UpdateOutcome> {
    open_release_page()
}

#[cfg(target_os = "macos")]
fn brew_upgrade() -> CmdResult<UpdateOutcome> {
    let Some(brew) = find_brew() else { return open_release_page() };
    let out = Command::new(brew)
        .args(["upgrade", "--cask", BREW_CASK])
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .output()
        .map_err(|e| format!("could not run Homebrew ({e})"))?;
    if !out.status.success() {
        return Err(
            format!("Homebrew could not update EzReader ({})", String::from_utf8_lossy(&out.stderr).trim()).into()
        );
    }
    reopen(&running_bundle().unwrap_or_else(|| PathBuf::from("/Applications/EzReader.app")))?;
    Ok(UpdateOutcome::Restarting)
}

#[cfg(target_os = "macos")]
fn find_brew() -> Option<&'static str> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| Path::new(p).exists())
}

/// Runs `brew upgrade` in the background, after EzReader has closed.
#[cfg(target_os = "macos")]
fn brew_upgrade_after_exit(relaunch: bool) -> Result<(), String> {
    let brew = find_brew().ok_or("Homebrew not found")?;
    let bundle = running_bundle().unwrap_or_else(|| PathBuf::from("/Applications/EzReader.app"));
    // $0 = brew, $1 = cask, $2 = bundle to reopen (empty: do not reopen).
    let script = r#""$0" upgrade --cask "$1" >/dev/null 2>&1; [ -n "$2" ] && /usr/bin/open -n "$2""#;
    let reopen_arg = if relaunch { bundle.into_os_string() } else { Default::default() };
    Command::new("/bin/sh")
        .args(["-c", script, brew, BREW_CASK])
        .arg(reopen_arg)
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        .spawn()
        .map_err(|e| format!("could not run Homebrew ({e})"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn running_bundle() -> Option<PathBuf> {
    current_exe()
        .and_then(|e| e.ancestors().nth(3).map(Path::to_path_buf))
        .filter(|b| b.extension().is_some_and(|x| x == "app"))
}

#[cfg(target_os = "macos")]
fn reopen(bundle: &Path) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg("-n")
        .arg(bundle)
        .spawn()
        .map_err(|e| format!("could not restart EzReader ({e})"))?;
    Ok(())
}

/// A bundle that can be swapped in place: not run from the disk image itself
/// nor from the read-only copy macOS makes of quarantined apps.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn bundle_is_replaceable(bundle: &Path) -> bool {
    let s = bundle.to_string_lossy();
    !s.starts_with("/Volumes/") && !s.contains("/AppTranslocation/")
}

/// Copies the app out of the downloaded disk image over the running one.
/// Called once every window has closed.
#[cfg(target_os = "macos")]
fn replace_bundle(dmg: &Path) -> Result<PathBuf, String> {
    let bundle = running_bundle().ok_or("not running from an app bundle")?;
    if !bundle_is_replaceable(&bundle) {
        return Err("EzReader runs from a place it cannot replace".into());
    }
    let mount = std::env::temp_dir().join(format!("ezreader-update-{}", std::process::id()));
    std::fs::create_dir_all(&mount).map_err(|e| e.to_string())?;
    let attached = Command::new("/usr/bin/hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint"])
        .arg(&mount)
        .arg(dmg)
        .status()
        .is_ok_and(|s| s.success());
    let result = if attached { copy_bundle_from(&mount, &bundle) } else { Err("could not open the disk image".into()) };
    if attached {
        let _ = Command::new("/usr/bin/hdiutil").args(["detach", "-quiet", "-force"]).arg(&mount).status();
    }
    let _ = std::fs::remove_dir(&mount);
    let _ = std::fs::remove_file(dmg);
    result.map(|()| bundle)
}

#[cfg(target_os = "macos")]
fn copy_bundle_from(mount: &Path, bundle: &Path) -> Result<(), String> {
    let source = std::fs::read_dir(mount)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "app"))
        .ok_or("no app in the disk image")?;
    let new = with_suffix(bundle, ".new");
    let old = with_suffix(bundle, ".old");
    let _ = std::fs::remove_dir_all(&new);
    let _ = std::fs::remove_dir_all(&old);
    let copied = Command::new("/usr/bin/ditto").arg(&source).arg(&new).status().is_ok_and(|s| s.success());
    if !copied {
        let _ = std::fs::remove_dir_all(&new);
        return Err("could not copy the new version".into());
    }
    let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&new).status();
    if let Err(e) = std::fs::rename(bundle, &old) {
        let _ = std::fs::remove_dir_all(&new);
        return Err(format!("could not replace EzReader ({e})"));
    }
    if let Err(e) = std::fs::rename(&new, bundle) {
        let _ = std::fs::rename(&old, bundle);
        let _ = std::fs::remove_dir_all(&new);
        return Err(format!("could not replace EzReader ({e})"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Microsoft Store updates through `StoreContext`: silent, so no window is
/// needed, and always to the newest published version.
#[cfg(target_os = "windows")]
mod store {
    use windows::core::Interface;
    use windows_collections::IIterable;
    use windows::Services::Store::{StoreContext, StorePackageUpdate, StorePackageUpdateState};

    fn msg(e: windows::core::Error) -> String {
        e.message()
    }

    fn context() -> Result<StoreContext, String> {
        // SAFETY: joins this thread to the multithreaded apartment; a second
        // call on the same thread only returns an error we can ignore.
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
        }
        StoreContext::GetDefault().map_err(msg)
    }

    fn pending_updates(ctx: &StoreContext) -> Result<Option<IIterable<StorePackageUpdate>>, String> {
        let list = ctx.GetAppAndOptionalStorePackageUpdatesAsync().and_then(|op| op.join()).map_err(msg)?;
        if list.Size().map_err(msg)? == 0 {
            return Ok(None);
        }
        list.cast::<IIterable<StorePackageUpdate>>().map(Some).map_err(msg)
    }

    /// Downloads every pending update. False when there is none, or when the
    /// user turned off automatic updates (metered connection, Store settings).
    pub fn download() -> Result<bool, String> {
        let ctx = context()?;
        if !ctx.CanSilentlyDownloadStorePackageUpdates().map_err(msg)? {
            return Ok(false);
        }
        let Some(updates) = pending_updates(&ctx)? else { return Ok(false) };
        let result = ctx.TrySilentDownloadStorePackageUpdatesAsync(&updates).and_then(|op| op.join()).map_err(msg)?;
        Ok(result.OverallState().map_err(msg)? == StorePackageUpdateState::Completed)
    }

    /// Installs what `download` fetched. Windows ends this process to do it.
    pub fn install(relaunch: bool) -> Result<(), String> {
        if relaunch {
            use windows::Win32::System::Recovery::{RegisterApplicationRestart, REGISTER_APPLICATION_RESTART_FLAGS};
            // SAFETY: a null command line means "same arguments as now".
            unsafe {
                let _ = RegisterApplicationRestart(windows::core::PCWSTR::null(), REGISTER_APPLICATION_RESTART_FLAGS(0));
            }
        }
        let ctx = context()?;
        let Some(updates) = pending_updates(&ctx)? else { return Ok(()) };
        ctx.TrySilentDownloadAndInstallStorePackageUpdatesAsync(&updates).and_then(|op| op.join()).map_err(msg)?;
        Ok(())
    }
}

fn open_release_page() -> CmdResult<UpdateOutcome> {
    crate::commands::shell::open_url(RELEASE_PAGE.into())?;
    Ok(UpdateOutcome::Opened)
}

fn shell_open(target: &str) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        use winapi::um::shellapi::ShellExecuteW;
        use winapi::um::winuser::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (verb, target) = (wide("open"), wide(target));
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
            return Err(format!("could not open it (error {code})").into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let opener = if cfg!(target_os = "macos") { "/usr/bin/open" } else { "xdg-open" };
        Command::new(opener).arg(target).spawn().map_err(|e| format!("could not open it ({e})"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Asset {
        Asset { name: name.into(), browser_download_url: format!("https://x/{name}"), digest: None }
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(is_newer("1.1.0", "1.0.0"));
        assert!(is_newer("v1.10.0", "1.9.3"));
        assert!(is_newer("2.0", "1.99.99"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.1.0"));
        assert!(!is_newer("1.1.0-beta.1", "1.1.0"));
    }

    #[test]
    fn macos_looks_for_updates_in_the_tap() {
        assert_eq!(latest_url(Channel::Dmg), MAC_LATEST_URL);
        assert_eq!(latest_url(Channel::Homebrew), MAC_LATEST_URL);
        assert_eq!(latest_url(Channel::Installer), LATEST_URL);
        assert_eq!(latest_url(Channel::Deb), LATEST_URL);
    }

    #[test]
    fn each_channel_gets_its_file() {
        let assets = [
            asset("ezreader-1.1.0-macos-universal.dmg"),
            asset("ezreader-1.1.0-security-report.pdf"),
            asset("ezreader-1.1.0-win-x64-setup.exe"),
            asset("ezreader-1.1.0-win-x64.msix"),
            asset("ezreader-portable-1.1.0-linux-x64"),
            asset("ezreader-portable-1.1.0-win-x64.exe"),
            asset("ezreader_1.1.0_amd64.deb"),
        ];
        let name = |c, w| pick_asset(&assets, c, w).map(|a| a.name.as_str());
        assert_eq!(name(Channel::Installer, true), Some("ezreader-1.1.0-win-x64-setup.exe"));
        assert_eq!(name(Channel::Portable, true), Some("ezreader-portable-1.1.0-win-x64.exe"));
        assert_eq!(name(Channel::Portable, false), Some("ezreader-portable-1.1.0-linux-x64"));
        assert_eq!(name(Channel::Deb, false), Some("ezreader_1.1.0_amd64.deb"));
        assert_eq!(name(Channel::Dmg, false), Some("ezreader-1.1.0-macos-universal.dmg"));
        assert_eq!(name(Channel::Store, true), None);
        assert_eq!(name(Channel::Homebrew, false), None);
    }

    fn facts<'a>(os: &'a str, exe: &'a str) -> InstallFacts<'a> {
        InstallFacts { os, exe, has_uninstaller: false, in_caskroom: false, appimage: false }
    }

    #[test]
    fn channel_comes_from_where_the_app_lives() {
        let store = r"C:\Program Files\WindowsApps\AlexBoudon.EzReader_1.1.0.0_x64__8wekyb3d8bbwe\EzReader.exe";
        assert_eq!(classify(&facts("windows", store)), Channel::Store);
        let installed = r"C:\Users\a\AppData\Local\EzReader\EzReader.exe";
        assert_eq!(
            classify(&InstallFacts { has_uninstaller: true, ..facts("windows", installed) }),
            Channel::Installer
        );
        assert_eq!(classify(&facts("windows", r"C:\Users\a\Downloads\ezreader-portable.exe")), Channel::Portable);
        let app = "/Applications/EzReader.app/Contents/MacOS/ezreader-portable";
        assert_eq!(classify(&InstallFacts { in_caskroom: true, ..facts("macos", app) }), Channel::Homebrew);
        assert_eq!(classify(&facts("macos", app)), Channel::Dmg);
        assert_eq!(classify(&facts("linux", "/usr/bin/ezreader-portable")), Channel::Deb);
        assert_eq!(classify(&facts("linux", "/home/a/bin/ezreader")), Channel::Portable);
        assert_eq!(
            classify(&InstallFacts { appimage: true, ..facts("linux", "/tmp/.mount_x/usr/bin/e") }),
            Channel::Other
        );
    }

    #[test]
    fn downloads_must_match_their_checksum() {
        let sha_abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(digest_matches(b"abc", Some(sha_abc)));
        assert!(!digest_matches(b"abd", Some(sha_abc)));
        assert!(!digest_matches(b"abc", None));
        assert!(!digest_matches(b"abc", Some("md5:900150983cd24fb0d6963f7d28e17f72")));
    }

    #[test]
    fn release_json_parses() {
        let json = r#"{"tag_name":"v1.1.0","assets":[{"name":"a.exe","browser_download_url":"https://x/a.exe","digest":"sha256:00"}],"other":1}"#;
        let r: Release = serde_json::from_str(json).unwrap();
        assert_eq!(r.tag_name, "v1.1.0");
        assert_eq!(r.assets[0].digest.as_deref(), Some("sha256:00"));
    }

    #[test]
    fn curl_only_speaks_https() {
        let cmd = curl_get("1.2.3", 15);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        for pair in [["--proto", "=https"], ["--proto-redir", "=https"], ["--max-time", "15"], ["-A", "EzReader/1.2.3"]]
        {
            assert!(args.windows(2).any(|w| w == pair), "{pair:?} missing from {args:?}");
        }
        assert!(args.contains(&"--tlsv1.2".to_string()));
    }

    #[test]
    fn a_failed_download_leaves_no_file() {
        let dest = std::env::temp_dir().join(format!("ezreader-update-test-{}", std::process::id()));
        std::fs::write(&dest, b"stale").unwrap();
        let mut a = asset("EzReader.exe");
        a.browser_download_url = "http://127.0.0.1:1/EzReader.exe".into();
        assert!(download(&a, &dest, "1.0.0").is_err());
        assert!(!dest.exists());
    }

    #[test]
    fn this_build_has_a_channel_and_no_leftover() {
        let _ = detect_channel();
        assert!(current_exe().is_some());
        remove_leftover();
        assert!(!with_suffix(&current_exe().unwrap(), ".old").exists());
    }

    #[test]
    fn only_quiet_channels_update_on_their_own() {
        for c in [Channel::Installer, Channel::Portable, Channel::Homebrew, Channel::Dmg, Channel::Store] {
            assert!(installs_silently(c), "{c:?}");
        }
        // Outside Windows there is no Store to ask.
        #[cfg(not(target_os = "windows"))]
        assert_eq!(stage(Channel::Store, "1.0.0"), Ok(None));
        // A .deb needs the user's password.
        for c in [Channel::Deb, Channel::Other] {
            assert!(!installs_silently(c), "{c:?}");
            assert_eq!(stage(c, "1.0.0"), Ok(None));
        }
    }

    #[test]
    fn the_silent_installer_shows_nothing_and_keeps_settings() {
        assert_eq!(SILENT_INSTALLER_ARGS, ["/S", "/UPDATE"]);
        assert!(INSTALLER_ARGS.contains(&"/UPDATE"));
    }

    #[test]
    fn an_update_waits_for_exit_and_runs_once() {
        let state = PendingUpdate::default();
        assert!(!state.is_ready());
        state.set(Pending::Homebrew);
        assert!(state.is_ready());
        assert_eq!(state.take(), Some(Pending::Homebrew));
        assert_eq!(state.take(), None);
    }

    #[test]
    fn a_bundle_on_the_disk_image_is_left_alone() {
        assert!(bundle_is_replaceable(Path::new("/Applications/EzReader.app")));
        assert!(bundle_is_replaceable(Path::new("/Users/a/Applications/EzReader.app")));
        assert!(!bundle_is_replaceable(Path::new("/Volumes/EzReader/EzReader.app")));
        assert!(!bundle_is_replaceable(Path::new("/private/var/folders/x/AppTranslocation/1/d/EzReader.app")));
    }

    #[test]
    fn suffix_is_appended_to_the_whole_name() {
        assert_eq!(with_suffix(Path::new("dir/EzReader.exe"), ".old"), PathBuf::from("dir/EzReader.exe.old"));
    }
}
