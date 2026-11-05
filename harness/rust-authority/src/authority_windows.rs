//! Native Windows authority transport. No WSL, Unix socket, or unauthenticated
//! TCP fallback. Uses a local named pipe whose DACL allows only the current
//! Windows user and SYSTEM, PIPE_REJECT_REMOTE_CLIENTS, and per-request
//! impersonation to verify the caller's Windows account SID. A separate
//! 32+ character authority token is required by the shared protocol.
//!
//! IMPORTANT: this code must pass the Windows MSVC CI build and real Win32
//! client/ACL/timeout acceptance before enabling native run-state writes.
use super::{handle_op, recover_all, token_matches, write_status, AuthorityConfig, MAX_REQUEST_BYTES, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::null_mut;
use std::time::{Duration, Instant};

const DEFAULT_PIPE: &str = r"\\.\pipe\singularity-repoql-authority";
const PREFIX: &str = r"\\.\pipe\";
const INVALID_HANDLE: isize = -1;
const PIPE_ACCESS_DUPLEX: u32 = 3;
const FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
const PIPE_REJECT_REMOTE_CLIENTS: u32 = 8;
const ERROR_PIPE_CONNECTED: i32 = 535;
const TOKEN_QUERY: u32 = 8;
const TOKEN_USER: u32 = 1;
const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
const ERROR_IO_PENDING: i32 = 997;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const CONNECT_TIMEOUT_MS: u32 = 5_000;
const REQUEST_BUDGET: Duration = Duration::from_secs(8);
const REPLY_BUDGET: Duration = Duration::from_secs(3);
const CANCEL_DRAIN_MS: u32 = 2_000;
// A fixed worker count bounds stalled clients and prevents unbounded thread
// creation. Each worker owns its own pipe instance, event and overlapped state.
const PIPE_WORKERS: u32 = 4;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;

#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    h_event: isize,
}


#[repr(C)]
struct SecurityAttributes {
    size: u32,
    descriptor: *mut c_void,
    inherit: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}
#[repr(C)]
struct TokenUser {
    user: SidAndAttributes,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateNamedPipeW(name: *const u16, access: u32, mode: u32, instances: u32, out_size: u32, in_size: u32,
        timeout: u32, security: *const SecurityAttributes) -> isize;
    fn ConnectNamedPipe(pipe: isize, overlapped: *mut Overlapped) -> i32;
    fn DisconnectNamedPipe(pipe: isize) -> i32;
    fn ReadFile(pipe: isize, buffer: *mut c_void, len: u32, read: *mut u32, overlapped: *mut Overlapped) -> i32;
    fn WriteFile(pipe: isize, buffer: *const c_void, len: u32, wrote: *mut u32, overlapped: *mut Overlapped) -> i32;
    fn CreateEventW(attributes: *const c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> isize;
    fn WaitForSingleObject(handle: isize, timeout: u32) -> u32;
    fn GetOverlappedResult(file: isize, overlapped: *mut Overlapped, transferred: *mut u32, wait: i32) -> i32;
    fn CancelIoEx(file: isize, overlapped: *mut Overlapped) -> i32;
    fn CreateFileW(name: *const u16, access: u32, share: u32, security: *const c_void,
        disposition: u32, flags: u32, template: isize) -> isize;
    fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetCurrentProcess() -> isize;
    fn GetCurrentThread() -> isize;
    fn LocalFree(p: *mut c_void) -> *mut c_void;
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn OpenThreadToken(thread: isize, access: u32, as_self: i32, token: *mut isize) -> i32;
    fn GetTokenInformation(token: isize, information_class: u32, buffer: *mut c_void, len: u32, result_len: *mut u32) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, sid_text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32,
        result: *mut *mut c_void, length: *mut u32) -> i32;
    fn ImpersonateNamedPipeClient(pipe: isize) -> i32;
    fn RevertToSelf() -> i32;
}
struct Handle(isize);
impl Drop for Handle {
    fn drop(&mut self) { if self.0 != INVALID_HANDLE && self.0 != 0 { unsafe { CloseHandle(self.0); } } }
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) { if !self.0.is_null() { unsafe { LocalFree(self.0); } } }
}
fn last_err(label: &str) -> String { format!("{label}: {}", std::io::Error::last_os_error()) }
fn wide(value: &str) -> Vec<u16> { OsStr::new(value).encode_wide().chain(Some(0)).collect() }

pub fn is_local_runs_dir(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::Disk(_)) )
}

pub fn validated_pipe_path(value: Option<&str>) -> Result<String, String> {
    let pipe = value.unwrap_or(DEFAULT_PIPE);
    let Some(name) = pipe.strip_prefix(PREFIX) else { return Err("AUTHORITY_PIPE_MUST_BE_LOCAL".into()); };
    if name.is_empty() || name.len() > 120 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("AUTHORITY_PIPE_NAME_INVALID".into());
    }
    Ok(pipe.to_string())
}

fn user_sid(token: isize) -> Result<String, String> {
    let mut len = 0u32;
    unsafe { GetTokenInformation(token, TOKEN_USER, null_mut(), 0, &mut len); }
    if len < std::mem::size_of::<TokenUser>() as u32 || len > 65536 { return Err("WINDOWS_TOKEN_USER_INVALID".into()); }
    let mut buffer = vec![0u64; (len as usize + 7) / 8];
    let rc = unsafe { GetTokenInformation(token, TOKEN_USER, buffer.as_mut_ptr().cast(), len, &mut len) };
    if rc == 0 { return Err(last_err("GetTokenInformation")); }
    let user = unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const TokenUser) };
    if user.user.sid.is_null() { return Err("WINDOWS_TOKEN_SID_UNAVAILABLE".into()); }
    let mut text: *mut u16 = null_mut();
    if unsafe { ConvertSidToStringSidW(user.user.sid, &mut text) } == 0 { return Err(last_err("ConvertSidToStringSidW")); }
    let _owner = Local(text.cast());
    let mut count = 0usize;
    while count < 256 && unsafe { *text.add(count) } != 0 { count += 1; }
    if count == 256 { return Err("WINDOWS_TOKEN_SID_TOO_LARGE".into()); }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, count) });
    if !sid.starts_with("S-1-") { return Err("WINDOWS_TOKEN_SID_INVALID".into()); }
    Ok(sid)
}
fn current_user_sid() -> Result<String, String> {
    let mut raw = 0isize;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 { return Err(last_err("OpenProcessToken")); }
    let token = Handle(raw);
    user_sid(token.0)
}
fn peer_is_current_user(pipe: isize, expected_sid: &str) -> bool {
    // Must run on the SAME thread that read the pipe request. On failure,
    // there is no fallback to trusting the client-provided PID or name.
    if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 { return false; }
    let result = (|| -> Result<bool, String> {
        let mut raw = 0isize;
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
            return Err("WINDOWS_PIPE_CALLER_TOKEN_UNAVAILABLE".into());
        }
        let token = Handle(raw);
        Ok(user_sid(token.0)? == expected_sid)
    })();
    // Failing to revert would allow subsequent filesystem mutations under a
    // caller's identity; terminate instead of continuing impersonated.
    if unsafe { RevertToSelf() } == 0 { std::process::abort(); }
    result.unwrap_or(false)
}
fn security_descriptor(sid: &str) -> Result<Local, String> {
    // Explicit protected DACL: only the current user and LocalSystem.
    // Never use the permissive default named-pipe security descriptor.
    let descriptor = wide(&format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)"));
    let mut raw: *mut c_void = null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.as_ptr(), 1, &mut raw, null_mut()) } == 0 {
        return Err(last_err("ConvertStringSecurityDescriptorToSecurityDescriptorW"));
    }
    Ok(Local(raw))
}
// The caller must keep both OVERLAPPED and all I/O buffers alive until the
// asynchronous operation finishes (including cancellation). Otherwise a
// driver could write into freed Rust memory. We abort on a broken cancellation
// drain instead of continuing with dangling kernel pointers.
fn remaining_ms(deadline: Instant) -> u32 {
    // Zero triggers immediate cancellation. Never return before draining a
    // pending OVERLAPPED, even when the deadline expired during its start.
    deadline.saturating_duration_since(Instant::now()).as_millis()
        .min(u32::MAX as u128) as u32
}

fn timed_io(
    pipe: isize,
    deadline: Instant,
    op_name: &str,
    operation: impl FnOnce(*mut Overlapped, *mut u32) -> i32,
) -> Result<u32, String> {
    let event = Handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) });
    if event.0 == INVALID_HANDLE || event.0 == 0 { return Err(last_err("CreateEventW")); }
    let mut state = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, h_event: event.0 };
    let mut transferred = 0;
    let rc = operation(&mut state, &mut transferred);
    if rc != 0 { return Ok(transferred); }
    let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    if op_name == "connect" && error == ERROR_PIPE_CONNECTED { return Ok(0); }
    if error != ERROR_IO_PENDING { return Err(format!("WINDOWS_PIPE_{op_name}: os error {error}")); }

    match unsafe { WaitForSingleObject(event.0, remaining_ms(deadline)) } {
        WAIT_OBJECT_0 => {
            if unsafe { GetOverlappedResult(pipe, &mut state, &mut transferred, 0) } == 0 {
                return Err(last_err("GetOverlappedResult"));
            }
            Ok(transferred)
        }
        WAIT_TIMEOUT => {
            unsafe { CancelIoEx(pipe, &mut state); }
            // CancelIoEx only requests cancellation. The kernel still owns the
            // buffer/OVERLAPPED until completion has been observed.
            if unsafe { WaitForSingleObject(event.0, CANCEL_DRAIN_MS) } != WAIT_OBJECT_0 {
                std::process::abort();
            }
            let _ = unsafe { GetOverlappedResult(pipe, &mut state, &mut transferred, 0) };
            Err(format!("WINDOWS_PIPE_{op_name}_TIMEOUT"))
        }
        _ => {
            unsafe { CancelIoEx(pipe, &mut state); }
            if unsafe { WaitForSingleObject(event.0, CANCEL_DRAIN_MS) } != WAIT_OBJECT_0 {
                std::process::abort();
            }
            let _ = unsafe { GetOverlappedResult(pipe, &mut state, &mut transferred, 0) };
            Err(format!("WINDOWS_PIPE_{op_name}_WAIT_FAILED"))
        }
    }
}

fn timed_read(pipe: isize, out: &mut [u8], deadline: Instant) -> Result<usize, String> {
    let count = timed_io(pipe, deadline, "read", |ov, completed| unsafe {
        ReadFile(pipe, out.as_mut_ptr().cast(), out.len() as u32, completed, ov)
    })?;
    Ok(count as usize)
}

fn timed_write_all(pipe: isize, data: &[u8], deadline: Instant) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < data.len() {
        let remaining = &data[offset..];
        let count = timed_io(pipe, deadline, "write", |ov, completed| unsafe {
            WriteFile(pipe, remaining.as_ptr().cast(), remaining.len() as u32, completed, ov)
        })? as usize;
        if count == 0 || count > remaining.len() { return Err("WINDOWS_PIPE_SHORT_WRITE".into()); }
        offset += count;
    }
    Ok(())
}

fn read_line(pipe: isize, deadline: Instant) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let count = timed_read(pipe, &mut buffer, deadline)?;
        if count == 0 { return Err("WINDOWS_PIPE_EOF".into()); }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_REQUEST_BYTES { return Err("REQUEST_TOO_LARGE".into()); }
        if let Some(newline) = bytes.iter().position(|b| *b == b'\n') {
            if bytes[newline + 1..].iter().any(|b| !b.is_ascii_whitespace()) {
                return Err("MULTIPLE_REQUESTS_REFUSED".into());
            }
            bytes.truncate(newline);
            return Ok(bytes);
        }
    }
}

fn write_reply(pipe: isize, reply: Value) {
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    bytes.push(b'\n');
    // DisconnectNamedPipe discards unread replies. Rather than a blocking
    // FlushFileBuffers (which has no deadline), wait up to three seconds for
    // the one-shot client to read its reply and close its pipe handle. Existing
    // Node CLI and native Rust clients both close after reading the newline.
    if timed_write_all(pipe, &bytes, Instant::now() + REPLY_BUDGET).is_ok() {
        let deadline = Instant::now() + REPLY_BUDGET;
        let mut extra = [0u8; 128];
        loop {
            match timed_read(pipe, &mut extra, deadline) {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    }
}

fn one_connection(pipe: isize, config: &AuthorityConfig, sid: &str) {
    let bytes = match read_line(pipe, Instant::now() + REQUEST_BUDGET) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error == "REQUEST_TOO_LARGE" || error == "MULTIPLE_REQUESTS_REFUSED" {
                write_reply(pipe, json!({"ok":false,"error":error}));
            }
            return;
        }
    };
    if !peer_is_current_user(pipe, sid) {
        write_reply(pipe, json!({"ok":false,"error":"PEER_SID_REFUSED"}));
        return;
    }
    let request: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => { write_reply(pipe, json!({"ok":false,"error":"INVALID_JSON"})); return; }
    };
    let token = request.get("token").and_then(Value::as_str).unwrap_or_default();
    if !token_matches(&config.token, token) {
        write_reply(pipe, json!({"ok":false,"error":"UNAUTHORIZED"}));
        return;
    }
    write_reply(pipe, handle_op(config, &request));
}

fn create_pipe(name: &[u16], sid: &str, first: bool) -> Result<Handle, String> {
    let descriptor = security_descriptor(sid)?;
    let attributes = SecurityAttributes {
        size: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: descriptor.0,
        inherit: 0,
    };
    let flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FIRST_PIPE_INSTANCE } else { 0 };
    let raw = unsafe { CreateNamedPipeW(name.as_ptr(), flags, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_WORKERS, 65536, 65536, CONNECT_TIMEOUT_MS, &attributes) };
    if raw == INVALID_HANDLE { return Err(last_err("CreateNamedPipeW")); }
    Ok(Handle(raw))
}

fn serve_worker(
    name: &[u16], sid: &str, config: &AuthorityConfig, initial: Option<Handle>,
) -> Result<(), String> {
    let mut initial = initial;
    loop {
        let pipe = match initial.take() {
            Some(pipe) => pipe,
            None => create_pipe(name, sid, false)?,
        };
        let connected = timed_io(pipe.0, Instant::now() + Duration::from_millis(CONNECT_TIMEOUT_MS as u64),
            "connect", |ov, _| unsafe { ConnectNamedPipe(pipe.0, ov) });
        if connected.is_ok() {
            one_connection(pipe.0, config, sid);
            unsafe { DisconnectNamedPipe(pipe.0); }
        }
    }
}

pub fn serve(config: AuthorityConfig) -> Result<(), String> {
    if config.token.len() < 32 { return Err("AUTHORITY_TOKEN_TOO_SHORT".into()); }
    let name = validated_pipe_path(config.socket_path.to_str())?;
    let sid = current_user_sid()?;
    let (recovered, failures) = recover_all(&config.runs_dir);
    if !failures.is_empty() { return Err(format!("AUTHORITY_RECOVERY_FAILED: {}", failures.join("; "))); }
    if recovered > 0 { eprintln!("recovered {recovered} authority run projections"); }
    let pipe_name = wide(&name);
    // FIRST_PIPE_INSTANCE prevents another process from pre-registering the
    // authority name and causing us to connect to the wrong server.
    let first = create_pipe(&pipe_name, &sid, true)?;
    write_status(&config, true);
    // Four fixed instances: a stalled client cannot consume the sole listener.
    // The RunStore still serialises each run's mutations through its own lock.
    std::thread::scope(|scope| {
        for _ in 1..PIPE_WORKERS {
            let name = &pipe_name;
            let sid = &sid;
            let config = &config;
            scope.spawn(move || {
                if let Err(error) = serve_worker(name, sid, config, None) {
                    eprintln!("authority worker stopped: {error}");
                }
            });
        }
        serve_worker(&pipe_name, &sid, &config, Some(first))
    })
}

pub fn request(pipe: &Path, req: &Value) -> Result<Value, String> {
    let name = validated_pipe_path(pipe.to_str())?;
    let wide_name = wide(&name);
    if unsafe { WaitNamedPipeW(wide_name.as_ptr(), CONNECT_TIMEOUT_MS) } == 0 {
        return Err(last_err("WaitNamedPipeW"));
    }
    let raw = unsafe { CreateFileW(wide_name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0,
        std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, 0) };
    if raw == INVALID_HANDLE { return Err(last_err("CreateFileW")); }
    let handle = Handle(raw);
    let mut bytes = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REQUEST_BYTES { return Err("REQUEST_TOO_LARGE".into()); }
    let deadline = Instant::now() + REQUEST_BUDGET;
    timed_write_all(handle.0, &bytes, deadline)?;
    let reply = read_line(handle.0, deadline)?;
    serde_json::from_slice(&reply).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_pipe_paths_only() {
        assert_eq!(validated_pipe_path(None).unwrap(), DEFAULT_PIPE);
        for value in [r"\\server\pipe\hijack", r"\\.\pipe\..", r"\\.\pipe\folder\p", r"\\.\pipe\", r"C:\temp\sock"] {
            assert!(validated_pipe_path(Some(value)).is_err(), "{value}");
        }
    }
}
