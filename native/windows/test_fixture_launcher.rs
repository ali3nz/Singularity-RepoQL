// Test transport only: an .exe entry point for a Node CLI fixture on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]
use std::env;
use std::process::{self, Command, Stdio};

fn main() {
    let script = match env::current_exe() {
        Ok(path) => path.with_extension("cjs"),
        Err(_) => process::exit(1),
    };
    let mut command = Command::new(env!("SINGULARITY_TEST_NODE"));
    command
        .arg(script)
        .args(env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    match command.status() {
        Ok(status) => process::exit(status.code().unwrap_or(1)),
        Err(_) => process::exit(1),
    }
}
