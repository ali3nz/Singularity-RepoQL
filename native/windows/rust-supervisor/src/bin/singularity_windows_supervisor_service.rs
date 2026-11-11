//! Windows Service entrypoint (SCM). Install with register-supervisor-service.ps1.
//!
//!   singularity-windows-supervisor-service.exe service <absolute-config-json>
//!
//! The supervisor stays fail-closed: if any owned child exits, `run` returns and
//! this process exits non-zero so the SCM failure actions restart the whole stack.
//! On Stop the process exits; the Job Object (KILL_ON_JOB_CLOSE) kills every child.
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
mod svc {
    use singularity_windows_supervisor::{load, run};
    use std::{ffi::OsString, fs::OpenOptions, io::Write, path::PathBuf, sync::OnceLock, time::Duration};
    use windows_service::{
        define_windows_service,
        service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType},
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };

    const NAME: &str = "SingularitySupervisor";
    static CONFIG: OnceLock<PathBuf> = OnceLock::new();
    define_windows_service!(ffi_service_main, service_main);

    fn log(cfg: &std::path::Path, text: &str) {
        if let Some(parent) = cfg.parent() {
            let file = parent.join("supervisor-service.log");
            if file.metadata().map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false) {
                let _ = std::fs::rename(&file, parent.join("supervisor-service.previous.log"));
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
                let _ = writeln!(f, "{text}");
            }
        }
    }

    fn status(state: ServiceState, accept: ServiceControlAccept, code: u32) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: Duration::from_secs(30),
            process_id: None,
        }
    }

    fn service_main(_args: Vec<OsString>) {
        let cfg = CONFIG.get().cloned().unwrap_or_default();
        let event = |control: ServiceControl| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                log(&cfg_for_stop(), "stop requested");
                std::process::exit(0);
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let Ok(handle) = service_control_handler::register(NAME, event) else { std::process::exit(1) };
        let _ = handle.set_service_status(status(ServiceState::StartPending, ServiceControlAccept::empty(), 0));
        let _ = handle.set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            0,
        ));
        log(&cfg, "service running");
        let result = load(&cfg).and_then(run);
        match result {
            Ok(()) => {
                log(&cfg, "supervisor stopped");
                let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), 0));
            }
            Err(err) => {
                log(&cfg, &format!("supervisor failed: {err}"));
                // Non-zero exit makes the SCM apply the configured failure (restart) actions.
                let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), 1));
                std::process::exit(1);
            }
        }
    }

    fn cfg_for_stop() -> PathBuf { CONFIG.get().cloned().unwrap_or_default() }

    pub fn start(cfg: PathBuf) -> i32 {
        let _ = CONFIG.set(cfg);
        match service_dispatcher::start(NAME, ffi_service_main) { Ok(()) => 0, Err(_) => 1 }
    }
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [mode, path] = args.as_slice() else { std::process::exit(2) };
    if mode != "service" || !std::path::Path::new(path).is_absolute() || path.starts_with(r"\\") { std::process::exit(2); }
    std::process::exit(svc::start(std::path::PathBuf::from(path)));
}
#[cfg(not(windows))]
fn main() { std::process::exit(2); }
