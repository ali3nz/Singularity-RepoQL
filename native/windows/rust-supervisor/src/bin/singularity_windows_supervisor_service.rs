//! Windows Service entrypoint (SCM). Install with register-supervisor-service.ps1.
//!
//!   singularity-windows-supervisor-service.exe service  <absolute-config-json>   (runs the stack itself; needs the user's password to run as them)
//!   singularity-windows-supervisor-service.exe watchdog <absolute-config-json>   (SYSTEM service, no password: keeps the user's boot task healthy)
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
    static WATCHDOG: OnceLock<bool> = OnceLock::new();
    const TASK: &str = "Singularity-Rust-Native-Supervisor";
    const PORTS: [u16; 3] = [18431, 18421, 18126];
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
        if let Some(dir) = std::path::Path::new(&cfg).parent() {
            std::env::set_var("SINGULARITY_SUPERVISOR_LOG_DIR", dir);
        }
        if WATCHDOG.get().copied().unwrap_or(false) {
            watch(&cfg);
            std::process::exit(0);
        }
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

    fn healthy(port: u16) -> bool {
        use std::io::Read;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return false };
        let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
        if s.write_all(format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).is_err() { return false }
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).unwrap_or(0);
        std::str::from_utf8(&buf[..n]).map(|t| t.starts_with("HTTP/1.1 200") || t.starts_with("HTTP/1.0 200")).unwrap_or(false)
    }

    fn schtasks(verb: &str) {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("schtasks.exe").args([verb, "/TN", TASK])
            .creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    }

    /// Password-free supervision: the stack runs as the user via the boot task; this SYSTEM service
    /// starts that task at boot and restarts it when the stack stops answering (3 bad checks in a row).
    fn watch(cfg: &std::path::Path) {
        log(cfg, "watchdog running");
        let mut bad = 0u32;
        loop {
            if PORTS.iter().all(|p| healthy(*p)) { bad = 0; } else { bad += 1; }
            if bad >= 3 {
                log(cfg, "stack unhealthy; restarting task");
                schtasks("/End");
                std::thread::sleep(Duration::from_secs(5));
                schtasks("/Run");
                bad = 0;
                std::thread::sleep(Duration::from_secs(90)); // grace while the stack boots
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    }

    fn cfg_for_stop() -> PathBuf { CONFIG.get().cloned().unwrap_or_default() }

    pub fn start(cfg: PathBuf, watchdog: bool) -> i32 {
        let _ = CONFIG.set(cfg);
        let _ = WATCHDOG.set(watchdog);
        match service_dispatcher::start(NAME, ffi_service_main) { Ok(()) => 0, Err(_) => 1 }
    }
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [mode, path] = args.as_slice() else { std::process::exit(2) };
    if (mode != "service" && mode != "watchdog") || !std::path::Path::new(path).is_absolute() || path.starts_with(r"\\") { std::process::exit(2); }
    std::process::exit(svc::start(std::path::PathBuf::from(path), mode == "watchdog"));
}
#[cfg(not(windows))]
fn main() { std::process::exit(2); }
