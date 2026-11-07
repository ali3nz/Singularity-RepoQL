//! Windows-native process supervisor core. No shell execution, no blind PID kills.
//! The Windows Job Object binds every launched child to this supervisor's lifetime.
//! This is source-review code until it builds and passes native Windows acceptance.
pub mod backend_capacity;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::process::{Child, Command, Stdio};
use std::thread;

pub const SCHEMA: &str = "singularity-rust-supervisor/v1";
pub const MAX_COMPONENTS: usize = 16;

// Windows only: accept normal local drive-absolute paths. A UNC share, Win32
// device namespace or verbatim path must never become a supervisor executable.
fn local_absolute(path: &Path) -> bool {
    if !path.is_absolute() { return false; }
    #[cfg(windows)]
    {
        use std::path::{Component as PathComponent, Prefix};
        matches!(path.components().next(),
                 Some(PathComponent::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
    }
    #[cfg(not(windows))]
    { true }
}

fn assert_existing_path_safe(path: &Path, want_file: bool) -> Result<(), String> {
    if !local_absolute(path) { return Err("remote or relative path refused".into()); }
    // Reject all ancestor reparse points (including junctions) rather than only
    // a symlink at the final path. The process owner must not follow mutable
    // directory redirections after configuration validation.
    let mut cursor = Some(path);
    while let Some(part) = cursor {
        let meta = fs::symlink_metadata(part).map_err(|_| "path not found".to_string())?;
        if meta.file_type().is_symlink() { return Err("symlink path refused".into()); }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
            if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
                return Err("Windows reparse point refused".into());
            }
        }
        cursor = part.parent();
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "path not found".to_string())?;
    if want_file && !meta.file_type().is_file() { return Err("expected executable or configuration file".into()); }
    if !want_file && !meta.file_type().is_dir() { return Err("expected working directory".into()); }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Health {
    pub port: u16,
    pub path: String,
    #[serde(default = "default_ready_ms")]
    pub ready_timeout_ms: u64,
}
fn default_ready_ms() -> u64 { 30_000 }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub health: Option<Health>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Stack {
    pub schema: String,
    pub variant: u8,
    pub repoql_version: String,
    pub components: Vec<Component>,
}

pub fn validate(stack: &Stack) -> Result<(), String> {
    if stack.schema != SCHEMA { return Err("invalid supervisor schema".into()); }
    if !(1..=4).contains(&stack.variant) { return Err("option must be 1..4".into()); }
    if stack.repoql_version != "1.7.18" { return Err("RepoQL must be exactly 1.7.18".into()); }
    if stack.components.is_empty() || stack.components.len() > MAX_COMPONENTS {
        return Err("component count out of bounds".into());
    }
    let mut seen = HashSet::new();
    let mut ports = HashSet::new();
    for c in &stack.components {
        if c.id.is_empty() || c.id.len() > 64 || !c.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err("invalid component id".into());
        }
        if !seen.insert(&c.id) { return Err("duplicate component id".into()); }
        if (stack.variant == 1 || stack.variant == 3)
            && (c.id.contains("office") || c.id.contains("ghost")) {
            return Err("Office/Ghost forbidden in lean options".into());
        }
        if !local_absolute(&c.executable) || !local_absolute(&c.working_dir) {
            return Err("executable and working directory must be absolute".into());
        }
        if c.executable.to_string_lossy().contains('\r') || c.executable.to_string_lossy().contains('\n') { return Err("invalid executable path".into()); }
        if c.args.len() > 64 || c.args.iter().any(|x| x.len() > 4096 || x.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) || ["--password=", "--token=", "api_key=", "secret="].iter().any(|prefix| x.to_ascii_lowercase().contains(prefix))) {
            return Err("invalid command arguments".into());
        }
        for (key, value) in &c.env {
            if key.is_empty() || key.len() > 100 || !key.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') || value.len() > 8192 || value.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
                return Err("invalid child environment".into());
            }
            // Never carry secrets in a versionable launcher config.
            if ["TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "AUTHORIZATION", "CREDENTIAL"].iter().any(|s| key.contains(s)) {
                return Err("credentials must come from an ACL-protected file, not the launcher".into());
            }
        }
        if let Some(h) = &c.health {
            if h.port == 0 || !ports.insert(h.port) || !h.path.starts_with('/')
                || h.path.len() > 128 || h.path.chars().any(|ch| matches!(ch, '\r' | '\n' | '?' | '#' | ' '))
                || !(100..=300_000).contains(&h.ready_timeout_ms) {
                return Err("invalid or duplicate loopback health check".into());
            }
        }
    }
    Ok(())
}

pub fn preflight(stack: &Stack) -> Result<(), String> {
    validate(stack)?;
    for c in &stack.components {
        assert_existing_path_safe(&c.executable, true).map_err(|err| format!("{} executable: {err}", c.id))?;
        assert_existing_path_safe(&c.working_dir, false).map_err(|err| format!("{} working directory: {err}", c.id))?;
    }
    Ok(())
}

pub fn load(path: &Path) -> Result<Stack, String> {
    assert_existing_path_safe(path, true).map_err(|_| "unsafe configuration file".to_string())?;
    let meta = fs::symlink_metadata(path).map_err(|_| "config not found".to_string())?;
    if meta.len() > 128 * 1024 { return Err("invalid configuration file".into()); }
    let raw = fs::read(path).map_err(|_| "cannot read config".to_string())?;
    let content = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw);
    let stack: Stack = serde_json::from_slice(content).map_err(|e| format!("invalid configuration JSON: {e}"))?;
    preflight(&stack)?;
    Ok(stack)
}

#[cfg(windows)]
mod owned_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    type Handle = *mut c_void;
    const CREATE_SUSPENDED: u32 = 0x00000004;
    // A supervised console child must not display a console at startup.
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const TH32CS_SNAPTHREAD: u32 = 0x00000004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    // THREADENTRY32 is a public Win32 structure. The primary thread must
    // belong to our exact newly-created PID, and be the only thread present.
    #[repr(C)]
    #[derive(Default)]
    struct ThreadEntry {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_pid: u32,
        base_priority: i32,
        delta_priority: i32,
        flags: u32,
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    #[link(name="kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, info_class: u32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
        fn ResumeThread(thread: Handle) -> u32;
    }
    pub struct Job(Handle);
    impl Job {
        pub fn new() -> Result<Self, String> {
            let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if h.is_null() { return Err("CreateJobObjectW failed".into()); }
            let job = Self(h);
            let mut limit = ExtendedLimits::default();
            limit.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe { SetInformationJobObject(job.0, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&limit as *const ExtendedLimits).cast(), std::mem::size_of::<ExtendedLimits>() as u32) };
            if ok == 0 { return Err("cannot set kill-on-close Job Object".into()); }
            Ok(job)
        }
        pub fn assign(&self, child: &Child) -> Result<(), String> {
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) } == 0 {
                return Err("cannot assign child to owned Job Object".into());
            }
            Ok(())
        }
        // Windows std::process::Command creates a running process by default.
        // CREATE_SUSPENDED avoids any user code running before job assignment.
        pub(super) fn spawn_suspended(command: &mut std::process::Command) -> Result<Child, String> {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            command.spawn().map_err(|e| format!("suspended process creation failed: {e}"))
        }
        pub(super) fn resume_only_primary_thread(pid: u32) -> Result<(), String> {
            use std::time::Duration;
            // Snapshot enumeration has a bounded retry for a newly created PID.
            // NEVER resume an unverified or multiple-thread process.
            for _ in 0..10 {
                let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
                if raw as isize == -1 || raw.is_null() {
                    return Err("cannot enumerate suspended process threads".into());
                }
                let snapshot = OwnedHandle(raw);
                let mut entry = ThreadEntry { size: std::mem::size_of::<ThreadEntry>() as u32, ..ThreadEntry::default() };
                let mut ids = Vec::new();
                let mut ok = unsafe { Thread32First(snapshot.0, &mut entry) };
                while ok != 0 {
                    if entry.owner_pid == pid { ids.push(entry.thread_id); }
                    entry.size = std::mem::size_of::<ThreadEntry>() as u32;
                    ok = unsafe { Thread32Next(snapshot.0, &mut entry) };
                }
                drop(snapshot);
                if ids.len() > 1 { return Err("suspended process has unexpected multiple threads".into()); }
                if ids.len() == 1 {
                    let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, ids[0]) };
                    if handle.is_null() { return Err("cannot open suspended primary thread".into()); }
                    let thread = OwnedHandle(handle);
                    let previous_count = unsafe { ResumeThread(thread.0) };
                    // A count of 1 proves the thread was suspended and is now runnable.
                    if previous_count != 1 { return Err("primary thread suspension state unexpected".into()); }
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err("suspended primary thread was not discovered in time".into())
        }
        pub fn spawn_contained(&self, command: &mut std::process::Command) -> Result<Child, String> {
            let mut child = Self::spawn_suspended(command)?;
            let result = self.assign(&child).and_then(|_| Self::resume_only_primary_thread(child.id()));
            if let Err(error) = result {
                // Kill a still-suspended child by its owned handle, never by an unrelated PID.
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(child)
        }
    }
    impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
}

#[cfg(not(windows))]
mod owned_job {
    use std::process::Child;
    pub struct Job;
    impl Job {
        pub fn new() -> Result<Self, String> { Err("native Windows is required for run mode".into()) }
        pub fn spawn_contained(&self, _cmd: &mut std::process::Command) -> Result<Child, String> {
            Err("native Windows required".into())
        }
    }
}

// An unrelated program may already own a configured loopback port. A 200
// status alone is never evidence that the child we launched is ready. Each
// supervised HTTP health endpoint must include a component-specific identity
// header: X-Singularity-Component: <component-id>. This is a readiness signal,
// NOT an authentication or proof-of-process-ownership primitive.
fn health_reply_matches(bytes: &[u8], component: &str) -> bool {
    let text = match std::str::from_utf8(bytes) { Ok(v) => v, Err(_) => return false };
    let headers = match text.split_once("\r\n\r\n") { Some((h, _)) => h, None => return false };
    let mut lines = headers.split("\r\n");
    let status = lines.next().unwrap_or("");
    if status != "HTTP/1.1 200 OK" && status != "HTTP/1.0 200 OK" && status != "HTTP/1.1 200" && status != "HTTP/1.0 200" {
        return false;
    }
    let mut matched = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { return false; };
        if name.trim().eq_ignore_ascii_case("x-singularity-component") {
            // Duplicate identity headers are ambiguous and must fail closed.
            if matched || value.trim() != component { return false; }
            matched = true;
        }
    }
    matched
}
fn health_probe(port: u16, path: &str, component: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddrV4, TcpStream, Ipv4Addr};
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = match TcpStream::connect_timeout(&addr.into(), Duration::from_millis(450)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(450)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(450)));
    if write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut bytes = [0u8; 4096];
    let mut len = 0;
    // A slow sender cannot keep extending the probe with individual bytes:
    // this is a whole-request deadline, not just a per-read timeout.
    let deadline = Instant::now() + Duration::from_millis(1200);
    while len < bytes.len() && !bytes[..len].windows(4).any(|part| part == b"\r\n\r\n") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return false; }
        if stream.set_read_timeout(Some(remaining.min(Duration::from_millis(400)))).is_err() { return false; }
        match stream.read(&mut bytes[len..]) { Ok(0) | Err(_) => return false, Ok(n) => len += n }
    }
    health_reply_matches(&bytes[..len], component)
}

pub fn run(stack: Stack) -> Result<(), String> {
    validate(&stack)?;
    let job = owned_job::Job::new()?;
    let mut children: Vec<(String, Child)> = Vec::new();
    // Guard each child handle on every failure path. The Job Object is never
    // released until all owned process handles are terminated/waited.
    let outcome = (|| -> Result<(), String> {
        for c in &stack.components {
            if assert_existing_path_safe(&c.executable, true).is_err() || assert_existing_path_safe(&c.working_dir, false).is_err() {
                return Err(format!("missing component executable or working directory: {}", c.id));
            }
            let mut cmd = Command::new(&c.executable);
            cmd.args(&c.args).current_dir(&c.working_dir).env_clear();
            // Explicitly preserve only essential Windows runtime variables.
            // Never inherit unrelated GUI/provider/session bearer tokens.
            for key in ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE"] {
                if let Some(value) = std::env::var_os(key) { cmd.env(key, value); }
            }
            cmd.envs(&c.env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            // Atomic with respect to child user code: create suspended, assign
            // to owned Job Object, then resume the verified primary thread.
            let child = job.spawn_contained(&mut cmd).map_err(|err| format!("{}: {err}", c.id))?;
            children.push((c.id.clone(), child));
            if let Some(h) = &c.health {
                let deadline = Instant::now() + Duration::from_millis(h.ready_timeout_ms);
                loop {
                    if let Some(status) = children.last_mut().unwrap().1.try_wait().map_err(|_| "child ownership status unreadable".to_string())? {
                        return Err(format!("component {} exited before ready: {status}", c.id));
                    }
                    if health_probe(h.port, &h.path, &c.id) { break; }
                    if Instant::now() >= deadline { return Err(format!("component {} not ready", c.id)); }
                    thread::sleep(Duration::from_millis(125));
                }
            }
        }
        // Fail closed on any child termination; a task scheduler may restart the
        // *whole* stack, but this process does not silently respawn one component.
        loop {
            for (id, child) in &mut children {
                if let Some(status) = child.try_wait().map_err(|_| "cannot verify child handle".to_string())? {
                    return Err(format!("component {id} exited: {status}"));
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    })();
    // Drop job (KILL_ON_JOB_CLOSE) before closing any child handles.
    drop(job);
    for (_, child) in &mut children { let _ = child.kill(); let _ = child.wait(); }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(variant: u8) -> Stack {
        Stack { schema: SCHEMA.into(), variant, repoql_version: "1.7.18".into(), components: vec![Component {
            id: "tencent-core".into(), executable: PathBuf::from(if cfg!(windows) { r"C:\Windows\System32\cmd.exe" } else { "/bin/echo" }),
            args: vec![], working_dir: PathBuf::from(if cfg!(windows) { r"C:\Windows" } else { "/tmp" }),
            env: BTreeMap::new(), health: None
        }]}
    }
    #[test] fn valid_profiles() { for n in 1..=4 { assert!(validate(&fixture(n)).is_ok()); } }
    #[test] fn exact_pin() { let mut f=fixture(1); f.repoql_version="1.7.17".into(); assert!(validate(&f).is_err()); f.repoql_version="1.7.15".into(); assert!(validate(&f).is_err()); }
    #[test] fn optional_components_are_rejected_in_lean_mode() {
        let mut f=fixture(1); f.components[0].id="claude-office".into(); assert!(validate(&f).is_err());
        f.variant=2; assert!(validate(&f).is_ok());
    }
    #[test] fn duplicate_identity_rejected() { let mut f=fixture(3); let exe = f.components[0].executable.clone(); let cwd = f.components[0].working_dir.clone(); f.components.push(Component { id: "tencent-core".into(), executable:exe, args:vec![], working_dir:cwd, env:BTreeMap::new(), health:None }); assert!(validate(&f).is_err()); }
    #[test] fn plaintext_secret_rejected() { let mut f=fixture(2); f.components[0].env.insert("API_KEY".into(), "secret".into()); assert!(validate(&f).is_err()); }
    #[test] fn denies_bad_health_and_injected_args() {
        let mut f = fixture(2);
        f.components[0].health = Some(Health {port: 8001, path: "/ready?token=secret".into(), ready_timeout_ms: 30_000});
        assert!(validate(&f).is_err());
        f.components[0].health = None;
        f.components[0].args.push("--token=plaintext".into());
        assert!(validate(&f).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn job_object_terminates_owned_child_on_close() {
        let job = owned_job::Job::new().expect("Job Object must be available");
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = job.spawn_contained(&mut command).expect("spawn suspended; assign; resume");
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut stopped = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() { stopped = true; break; }
            thread::sleep(Duration::from_millis(50));
        }
        if !stopped { let _ = child.kill(); let _ = child.wait(); }
        assert!(stopped, "closing job must terminate its owned child promptly");
    }
    #[cfg(windows)]
    #[test]
    fn suspended_child_cannot_execute_before_job_assignment() {
        let marker = std::env::temp_dir().join(format!("singularity-containment-{}-{}.marker", std::process::id(), 1));
        let _ = fs::remove_file(&marker);
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("[System.IO.File]::WriteAllText('{}','executed')", marker.display())]);
        let mut child = owned_job::Job::spawn_suspended(&mut command).expect("suspended creation");
        thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists(), "child ran before Job Object assignment");
        let job = owned_job::Job::new().expect("job");
        job.assign(&child).expect("assign before resuming");
        owned_job::Job::resume_only_primary_thread(child.id()).expect("resume exactly one thread");
        let exit = child.wait().expect("child completion");
        assert!(exit.success());
        assert!(marker.exists(), "child did not run after containment");
        let _ = fs::remove_file(&marker);
    }
    #[test] fn health_header_requires_exact_unambiguous_component() {
        let good=b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Singularity-Component: tencent-core\r\n\r\n";
        assert!(health_reply_matches(good, "tencent-core"));
        assert!(!health_reply_matches(good, "kanzo"));
        assert!(!health_reply_matches(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "tencent-core"));
        assert!(!health_reply_matches(b"HTTP/1.1 302 Found\r\nX-Singularity-Component: tencent-core\r\n\r\n", "tencent-core"));
        assert!(!health_reply_matches(b"HTTP/1.1 200 OK\r\nX-Singularity-Component: tencent-core\r\nX-Singularity-Component: tencent-core\r\n\r\n", "tencent-core"));
    }
    #[test] fn rejects_symlinked_executable_and_config_ancestor() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let base = std::env::temp_dir().join(format!("singularity-safe-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&base).unwrap();
        let file=base.join("bin.exe");
        fs::write(&file,b"test").unwrap();
        assert!(assert_existing_path_safe(&file,true).is_ok());
        #[cfg(unix)] {
            use std::os::unix::fs::symlink;
            let alias=base.join("alias");
            symlink(&base,&alias).unwrap();
            assert!(assert_existing_path_safe(&alias.join("bin.exe"),true).is_err());
        }
        let _=fs::remove_dir_all(&base);
    }
    #[test] fn no_run_outside_windows() { if !cfg!(windows) { assert!(run(fixture(1)).is_err()); } }
}
