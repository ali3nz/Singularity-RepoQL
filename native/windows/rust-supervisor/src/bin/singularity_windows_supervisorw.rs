//! Windowless task entrypoint. `singularity-windows-supervisor.exe check` remains
//! the console diagnostic; Task Scheduler only runs this GUI-subsystem binary.
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
fn main() {
    use singularity_windows_supervisor::{load, run};
    use std::{env, fs::OpenOptions, io::Write, path::Path};
    let args: Vec<String> = env::args().skip(1).collect();
    let [mode, path] = args.as_slice() else {
        std::process::exit(2)
    };
    let cfg = Path::new(path);
    if !cfg.is_absolute() || path.starts_with(r"\\") {
        std::process::exit(2);
    }
    if mode == "openmausbot" {
        // The task consumes the exit code. No ad hoc state or log writes.
        if singularity_windows_supervisor::openmausbot::run_openmausbot(cfg).is_err() {
            std::process::exit(1);
        }
        return;
    }
    if mode != "run" {
        std::process::exit(2);
    }
    let result = load(cfg).and_then(run);
    let text = match &result {
        Ok(()) => "stopped",
        Err(_) => "failed",
    };
    if let Some(parent) = cfg.parent() {
        let log = parent.join("supervisor-runtime.log");
        if log
            .metadata()
            .map(|m| m.len() > 4 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&log, parent.join("supervisor-runtime.previous.log"));
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(file, "supervisor {text}");
        }
    }
    if result.is_err() {
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
