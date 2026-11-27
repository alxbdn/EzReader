use crate::error::CmdResult;

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookState {
    available: bool,
    enabled: bool,
}

#[cfg(target_os = "windows")]
mod startup {
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
        if crate::commands::shell::is_packaged() {
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

    pub fn resume(memo: &std::path::Path, opted_out: bool, version: &str) {
        let Some(helper) = helper() else { return };
        let seen = std::fs::read_to_string(memo).ok();
        match super::quick_look_after_launch(enabled(), opted_out, seen.as_deref(), version) {
            super::QuickLookResume::Start => {
                let _ = std::process::Command::new(&helper).spawn();
            }
            super::QuickLookResume::TurnOn => {
                let _ = set(true, &helper);
            }
            super::QuickLookResume::Nothing => {}
        }
        let _ = std::fs::write(memo, version);
    }

    pub fn set(enabled: bool, helper: &std::path::Path) -> Result<(), String> {
        use windows::ApplicationModel::StartupTaskState;
        if crate::commands::shell::is_packaged() {
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
    Start,
    TurnOn,
    Nothing,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn quick_look_after_launch(enabled: bool, opted_out: bool, seen: Option<&str>, version: &str) -> QuickLookResume {
    match (enabled, opted_out, seen.map(str::trim)) {
        (true, _, _) => QuickLookResume::Start,
        (false, true, _) => QuickLookResume::Nothing,
        (false, false, Some(v)) if v == version => QuickLookResume::Nothing,
        (false, false, _) => QuickLookResume::TurnOn,
    }
}

#[cfg(target_os = "windows")]
fn quick_look_files(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some((dir.join("quick-look-seen"), dir.join("quick-look-off")))
}

pub fn resume_quick_look(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    if let Some((seen, off)) = quick_look_files(&app) {
        startup::resume(&seen, off.is_file(), &app.package_info().version.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[tauri::command]
pub async fn quick_look_state() -> QuickLookState {
    super::shell::off_main_thread(quick_look_probe).await
}

fn quick_look_probe() -> QuickLookState {
    #[cfg(target_os = "windows")]
    {
        if startup::helper().is_some() {
            return QuickLookState { available: true, enabled: startup::enabled() };
        }
    }
    QuickLookState::default()
}

#[tauri::command]
pub fn set_quick_look(app: tauri::AppHandle, enabled: bool) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        let helper = startup::helper().ok_or("quick-look-missing")?;
        startup::set(enabled, &helper)?;
        if let Some((_, off)) = quick_look_files(&app) {
            if enabled {
                let _ = std::fs::remove_file(&off);
            } else {
                let _ = std::fs::write(&off, "");
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
    fn quick_look_is_on_by_default_and_after_each_update() {
        assert_eq!(quick_look_after_launch(true, false, None, "1.2.0"), QuickLookResume::Start);
        assert_eq!(quick_look_after_launch(false, false, None, "1.2.0"), QuickLookResume::TurnOn);
        assert_eq!(quick_look_after_launch(false, false, Some("1.1.0\n"), "1.2.0"), QuickLookResume::TurnOn);
    }

    #[test]
    fn quick_look_stays_off_when_the_user_turned_it_off() {
        assert_eq!(quick_look_after_launch(false, true, Some("1.1.0"), "1.2.0"), QuickLookResume::Nothing);
        assert_eq!(quick_look_after_launch(false, true, None, "1.2.0"), QuickLookResume::Nothing);
    }

    #[test]
    fn quick_look_turned_off_elsewhere_waits_for_the_next_update() {
        assert_eq!(quick_look_after_launch(false, false, Some("1.2.0"), "1.2.0"), QuickLookResume::Nothing);
    }
}
