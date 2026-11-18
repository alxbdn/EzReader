#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::process::exit(ezreader_shell::quicklook::run(&args));
}

#[cfg(not(windows))]
fn main() {}
