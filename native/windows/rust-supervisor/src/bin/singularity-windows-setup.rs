//! Native GUI front end for exactly one reviewed installer phase at a time.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use singularity_windows_supervisor::setup;
    use std::{
        os::windows::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
    };

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(owner: isize, text: *const u16, title: *const u16, flags: u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, len: u32) -> u32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn dialog(text: &str, flags: u32) -> i32 {
        unsafe {
            MessageBoxW(
                0,
                wide(text).as_ptr(),
                wide("Singularity Windows Setup").as_ptr(),
                flags,
            )
        }
    }

    let cli: Vec<_> = std::env::args_os().skip(1).collect();
    if let [flag, path] = cli.as_slice() {
        if flag == "--validate-request" {
            let valid = setup::load(&PathBuf::from(path))
                .and_then(|request| request.command())
                .is_ok();
            std::process::exit(if valid { 0 } else { 2 });
        }
    }

    let run = || -> Result<(), &'static str> {
        let [flag, path] = cli.as_slice() else {
            return Err("Usage: singularity-windows-setup.exe --request ABSOLUTE_JSON_PATH");
        };
        if flag != "--request" {
            return Err("Usage: singularity-windows-setup.exe --request ABSOLUTE_JSON_PATH");
        }
        let request = setup::load(&PathBuf::from(path))?;
        let command = request.command()?;
        let driver = request.driver_root.display();
        let prompt = format!(
            "Phase: {:?}\n\nReviewed driver source: {}\n\nProceed with this phase only?",
            request.phase, driver
        );
        // No is the default for all phases. No child is launched on close.
        if dialog(&prompt, 0x0000_0124) != 6 {
            return Ok(());
        }
        let mut buf = [0u16; 32_768];
        let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if n == 0 || n >= buf.len() {
            return Err("SETUP_SYSTEM_DIRECTORY_UNAVAILABLE");
        }
        let system = String::from_utf16(&buf[..n]).map_err(|_| "SETUP_SYSTEM_DIRECTORY_INVALID")?;
        let powershell = PathBuf::from(system)
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        // Run the established driver as a direct argument vector, without
        // inheriting stdin or making private output visible in setup logs.
        let status = Command::new(powershell)
            .args(command)
            .current_dir(&request.driver_root)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "SETUP_PHASE_COULD_NOT_START")?;
        if !status.success() {
            return Err("The phase failed. Inspect the existing installer receipts and use its PowerShell phase directly for details.");
        }
        dialog(
            "The selected phase returned success. This does not verify live Windows acceptance.",
            0x40,
        );
        Ok(())
    };
    if let Err(error) = run() {
        dialog(error, 0x10);
        std::process::exit(2);
    }
}

#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
