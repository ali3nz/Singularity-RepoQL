//! Windows GUI-subsystem browser opener for the existing per-user dashboard.
//! No cmd/PowerShell process and no bearer key on the shortcut command line.
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
fn main() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::{env, path::PathBuf, ptr};
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let args: Vec<String> = env::args().skip(1).collect();
    let (port, state_argument) = match args.as_slice() {
        [] => (18100u16, None),
        [flag, p] if flag == "--port" => match p.parse::<u16>() {
            Ok(port) if port >= 1024 => (port, None),
            _ => std::process::exit(2),
        },
        [flag, p, dir_flag, dir] if flag == "--port" && dir_flag == "--state-dir" => {
            match p.parse::<u16>() {
                Ok(port) if port >= 1024 => (port, Some(PathBuf::from(dir))),
                _ => std::process::exit(2),
            }
        }
        _ => std::process::exit(2),
    };
    let local = match env::var_os("LOCALAPPDATA") {
        Some(s) => PathBuf::from(s),
        None => std::process::exit(2),
    };
    if !local.is_absolute() || local.to_string_lossy().starts_with(r"\\") {
        std::process::exit(2);
    }
    let dashboard_root = local.join("Singularity").join("Dashboard");
    let state = state_argument.unwrap_or_else(|| dashboard_root.clone());
    if !state.is_absolute()
        || state.to_string_lossy().starts_with(r"\")
        || !state.starts_with(&dashboard_root)
    {
        std::process::exit(2);
    }
    let url = format!("http://127.0.0.1:{port}/");
    let wide = |s: &str| -> Vec<u16> { OsStr::new(s).encode_wide().chain(Some(0)).collect() };
    let verb = wide("open");
    let target = wide(&url);
    // ShellExecute invokes the default browser handler directly; no console
    // subprocess or shell interpreter is started by Singularity.
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            1,
        )
    };
    if result <= 32 {
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only dashboard opener");
    std::process::exit(2);
}
