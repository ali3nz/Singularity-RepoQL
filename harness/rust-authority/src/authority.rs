// authority.rs — the exclusive state-authority transport for the Rust coordinator.
//
// Transport: one newline-delimited JSON request and one response per connection
// over a Unix domain socket. The socket lives inside the run tree, which is
// bind-mounted into the coordinator container, so the JavaScript harness and
// the host-side service address the same inode.
//
// Why a Unix socket and not loopback TCP: Sol's review (2026-10-24) requires
// caller authority, not just a loopback bind, in a shared container
// environment. SO_PEERCRED gives the kernel-attested uid of the connecting
// process; requests also carry a bearer token. Both must match.
//
// This module performs NO external effects. It validates and commits run-state
// operations through `run_state::RunStore` and answers bounded read queries.

use crate::run_state::{self, RunStore};
use serde_json::{json, Value};
use std::fs;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(windows)]
#[path = "authority_windows.rs"]
mod windows;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

pub const PROTOCOL_VERSION: u64 = 1;
pub const AUTHORITY_SCHEMA: &str = "orchestra-authority/1";
pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
#[cfg(unix)]
pub const MAX_CONNECTIONS: usize = 32;
#[cfg(unix)]
pub const SOCKET_NAME: &str = "authority.sock";
pub const META_DIR: &str = ".rust-authority";

pub struct AuthorityConfig {
    pub socket_path: PathBuf,
    pub runs_dir: PathBuf,
    pub token: String,
    #[cfg(unix)]
    pub expected_uid: u32,
}

pub fn token_matches(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Kernel-attested peer uid. A missing credential is a hard failure, never an
/// implicit allow.
#[cfg(unix)]
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc == 0 {
        Some(cred.uid)
    } else {
        None
    }
}

fn valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 128
        && !run_id.starts_with('.')
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !run_id.contains("..")
}

fn run_dir(runs_dir: &Path, run_id: &str) -> Result<PathBuf, String> {
    if !valid_run_id(run_id) {
        return Err("INVALID_RUN_ID".into());
    }
    Ok(runs_dir.join(run_id))
}

fn error_response(code: &str, extra: Value) -> Value {
    let mut out = json!({"ok": false, "error": code});
    if let (Some(obj), Some(extra)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    out
}

/// Converts store errors into a stable protocol error code. A `STALE_REV:12`
/// becomes `{"ok":false,"error":"STALE_REV","currentRev":12}` so the adapter can
/// report the authoritative revision without parsing prose.
fn store_error(message: String) -> Value {
    let (code, rest) = match message.split_once(':') {
        Some((code, rest)) => (code.to_string(), rest.to_string()),
        None => (message, String::new()),
    };
    let mut extra = json!({});
    if code == "STALE_REV" {
        if let Ok(rev) = rest.parse::<u64>() {
            extra = json!({"currentRev": rev});
        }
    }
    error_response(&code, extra)
}

fn snapshot_runs(runs_dir: &Path, limit: usize) -> Value {
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(read) = fs::read_dir(runs_dir) {
        for entry in read.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !path.is_dir() || name.starts_with('.') || name == "state" || name == "consult" {
                continue;
            }
            entries.push((name, path));
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = Vec::new();
    for (name, dir) in entries.into_iter().take(limit) {
        let authority: Value = fs::read_to_string(dir.join(run_state::AUTHORITY_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        let state: Value = match fs::metadata(dir.join(run_state::STATE_FILE)) {
            Ok(meta) if meta.len() <= run_state::MAX_STATE_BYTES as u64 => {
                fs::read_to_string(dir.join(run_state::STATE_FILE))
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or_else(|| json!({}))
            }
            _ => json!({}),
        };
        let lease = fs::read_to_string(dir.join(run_state::LEASE_FILE))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let expires = lease
            .as_ref()
            .and_then(|l| l.get("expiresAtMs"))
            .and_then(Value::as_u64);
        out.push(json!({
            "runId": name,
            "runState": state.get("runState"),
            "rev": authority.get("rev"),
            "journalRecords": authority.get("journalRecords"),
            "stateDigest": authority.get("stateDigest"),
            "epoch": authority.get("epoch"),
            "ownerId": authority.get("ownerId"),
            "leaseExpiresAtMs": authority.get("leaseExpiresAtMs"),
            "leaseActive": expires.map(|e| e > run_state::now_ms()).unwrap_or(false),
            "updatedAt": authority.get("updatedAt"),
            "stateAuthority": authority.get("stateAuthority").cloned().unwrap_or(json!("unmanaged")),
        }));
    }
    json!({
        "schema": AUTHORITY_SCHEMA,
        "stateAuthority": "rust",
        "generatedAt": run_state::now_ms(),
        "runCount": out.len(),
        "runs": out,
    })
}

pub(super) fn handle_op(config: &AuthorityConfig, request: &Value) -> Value {
    let Some(obj) = request.as_object() else {
        return error_response("INVALID_REQUEST", json!({}));
    };
    let version = obj.get("v").and_then(Value::as_u64).unwrap_or(0);
    if version != PROTOCOL_VERSION {
        return error_response("PROTOCOL_VERSION", json!({"supported": PROTOCOL_VERSION}));
    }
    let op = obj.get("op").and_then(Value::as_str).unwrap_or("");
    if op == "health" || op == "ping" {
        return json!({
            "ok": true,
            "schema": AUTHORITY_SCHEMA,
            "protocol": PROTOCOL_VERSION,
            "stateAuthority": "rust",
            "pid": std::process::id(),
            "runsDir": config.runs_dir.display().to_string(),
            "generatedAt": run_state::now_ms(),
        });
    }
    if op == "snapshot" {
        let limit = obj
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 1000) as usize;
        return json!({
            "ok": true,
            "schema": AUTHORITY_SCHEMA,
            "stateAuthority": "rust",
            "generatedAt": run_state::now_ms(),
            "runs": snapshot_runs(&config.runs_dir, limit)["runs"].clone(),
        });
    }
    let run_id = match obj.get("runId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return error_response("MISSING_RUN_ID", json!({})),
    };
    let dir = match run_dir(&config.runs_dir, &run_id) {
        Ok(dir) => dir,
        Err(code) => return error_response(&code, json!({})),
    };
    let store = RunStore::new(dir);
    // `peek` must not take the run lock or project anything: dashboard reads
    // never block a coordinator commit.
    if op == "peek" {
        return match store.peek() {
            Ok(v) => {
                let mut out = v;
                out["ok"] = json!(true);
                out["schema"] = json!(authority_schema());
                out
            }
            Err(e) => store_error(e),
        };
    }
    if op == "lease" {
        return store
            .execute(&json!({"action": "lease"}))
            .unwrap_or_else(store_error);
    }
    let mut payload = request.clone();
    payload["action"] = json!(op);
    match store.execute(&payload) {
        Ok(v) => v,
        Err(e) => store_error(e),
    }
}

fn authority_schema() -> &'static str {
    "orchestra-authority/1"
}

#[cfg(unix)]
fn handle_connection(mut stream: UnixStream, config: Arc<AuthorityConfig>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let uid = match peer_uid(&stream) {
        Some(uid) => uid,
        None => {
            let _ = stream.write_all(b"{\"ok\":false,\"error\":\"PEER_CREDENTIAL_UNAVAILABLE\"}\n");
            return;
        }
    };
    if uid != config.expected_uid {
        let _ = stream.write_all(b"{\"ok\":false,\"error\":\"PEER_UID_REFUSED\"}\n");
        return;
    }
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut line = String::new();
    let mut read_total = 0usize;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                read_total += n;
                if read_total > MAX_REQUEST_BYTES {
                    let _ = stream.write_all(b"{\"ok\":false,\"error\":\"REQUEST_TOO_LARGE\"}\n");
                    return;
                }
                let request: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = stream.write_all(b"{\"ok\":false,\"error\":\"INVALID_JSON\"}\n");
                        continue;
                    }
                };
                let presented = request
                    .get("token")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !token_matches(&config.token, presented) {
                    let _ = stream.write_all(b"{\"ok\":false,\"error\":\"UNAUTHORIZED\"}\n");
                    continue;
                }
                let response = handle_op(&config, &request);
                let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                bytes.push(b'\n');
                if stream.write_all(&bytes).is_err() {
                    return;
                }
                let _ = stream.flush();
            }
            Err(_) => return,
        }
    }
}

#[cfg(unix)]
fn prepare_socket(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create socket dir: {e}"))?;
    }
    if path.exists() {
        // A live service must not be replaced (would create two writers).
        match UnixStream::connect(path) {
            Ok(_) => return Err("AUTHORITY_ALREADY_RUNNING".into()),
            Err(_) => {
                fs::remove_file(path).map_err(|e| format!("remove stale socket: {e}"))?;
            }
        }
    }
    Ok(())
}

pub(super) fn write_status(config: &AuthorityConfig, socket_ready: bool) {
    let meta = config.runs_dir.join(META_DIR);
    let _ = fs::create_dir_all(&meta);
    let body = json!({
        "schema": AUTHORITY_SCHEMA,
        "stateAuthority": "rust",
        "pid": std::process::id(),
        "socket": config.socket_path.display().to_string(),
        "runsDir": config.runs_dir.display().to_string(),
        "protocol": PROTOCOL_VERSION,
        "ready": socket_ready,
        "startedAtMs": run_state::now_ms(),
    });
    let _ = fs::write(
        meta.join("status.json"),
        serde_json::to_vec_pretty(&body).unwrap_or_default(),
    );
}

/// Serves the authority protocol until the process is stopped. Sequential
/// accept with one short-lived thread per connection; the per-run file lock
/// serialises commits.
/// Rebuilds every managed projection from its journal before the listener
/// starts. A crash between the journal append and the projection write leaves
/// state.json stale; serving that would misreport a committed run.
pub fn recover_all(runs_dir: &Path) -> (usize, Vec<String>) {
    let mut recovered = 0usize;
    let mut failures = Vec::new();
    let Ok(entries) = fs::read_dir(runs_dir) else {
        return (0, failures);
    };
    for entry in entries.flatten().take(1000) {
        let dir = entry.path();
        if !dir.is_dir() || !dir.join(run_state::JOURNAL_FILE).is_file() {
            continue;
        }
        match RunStore::new(&dir).execute(&serde_json::json!({"action": "recover"})) {
            Ok(_) => recovered += 1,
            Err(error) => failures.push(format!(
                "{}: {error}",
                dir.file_name().and_then(|n| n.to_str()).unwrap_or("?")
            )),
        }
    }
    (recovered, failures)
}

#[cfg(unix)]
pub fn serve(config: AuthorityConfig) -> Result<(), String> {
    if config.token.len() < 32 {
        return Err("ORCHESTRA_RUST_AUTHORITY_TOKEN must be at least 32 characters".into());
    }
    let (recovered, failures) = recover_all(&config.runs_dir);
    for failure in &failures {
        eprintln!("authority recovery failed: {failure}");
    }
    if recovered > 0 {
        eprintln!("authority recovered {recovered} journal projection(s)");
    }
    prepare_socket(&config.socket_path)?;
    let listener = UnixListener::bind(&config.socket_path)
        .map_err(|e| format!("bind {}: {e}", config.socket_path.display()))?;
    let _ = fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o660));
    write_status(&config, true);
    eprintln!(
        "orchestra authority listening on {} (runs {})",
        config.socket_path.display(),
        config.runs_dir.display()
    );
    let config = Arc::new(config);
    let active = Arc::new(AtomicUsize::new(0));
    let served = Arc::new(AtomicU64::new(0));
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(_) => continue,
        };
        if active.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            let mut stream = stream;
            let _ = stream.write_all(b"{\"ok\":false,\"error\":\"TOO_MANY_CONNECTIONS\"}\n");
            continue;
        }
        active.fetch_add(1, Ordering::Relaxed);
        served.fetch_add(1, Ordering::Relaxed);
        let config = Arc::clone(&config);
        let active = Arc::clone(&active);
        std::thread::spawn(move || {
            handle_connection(stream, config);
            active.fetch_sub(1, Ordering::Relaxed);
        });
    }
    Ok(())
}

#[cfg(windows)]
pub fn serve(config: AuthorityConfig) -> Result<(), String> {
    windows::serve(config)
}

pub fn config_from_env() -> Result<AuthorityConfig, String> {
    let runs_dir = std::env::var("ORCHESTRA_RUNS_DIR")
        .map_err(|_| "ORCHESTRA_RUNS_DIR must be set explicitly".to_string())?;
    let runs_dir = PathBuf::from(runs_dir);
    if !runs_dir.is_absolute() {
        return Err("ORCHESTRA_RUNS_DIR must be an absolute path".into());
    }
    #[cfg(windows)]
    if !windows::is_local_runs_dir(&runs_dir) {
        return Err("ORCHESTRA_RUNS_DIR must be on a local Windows drive".into());
    }
    #[cfg(unix)]
    let socket_path = std::env::var("ORCHESTRA_RUST_AUTHORITY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| runs_dir.join(META_DIR).join(SOCKET_NAME));
    #[cfg(windows)]
    let socket_path = PathBuf::from(windows::validated_pipe_path(
        std::env::var("ORCHESTRA_RUST_AUTHORITY").ok().as_deref(),
    )?);
    let token = std::env::var("ORCHESTRA_RUST_AUTHORITY_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            std::env::var("ORCHESTRA_RUST_AUTHORITY_TOKEN_FILE")
                .ok()
                .and_then(|file| fs::read_to_string(file).ok())
                .map(|t| t.trim().to_string())
        })
        .ok_or("set ORCHESTRA_RUST_AUTHORITY_TOKEN or ORCHESTRA_RUST_AUTHORITY_TOKEN_FILE")?;
    #[cfg(unix)]
    let expected_uid = std::env::var("ORCHESTRA_RUST_AUTHORITY_UID")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or_else(|| unsafe { libc::geteuid() });
    Ok(AuthorityConfig {
        socket_path,
        runs_dir,
        token,
        #[cfg(unix)]
        expected_uid,
    })
}

/// Test helper: run one request against a live socket.
#[allow(dead_code)] // exercised by the module's socket tests
#[cfg(unix)]
pub fn request(socket: &Path, value: &Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|e| format!("connect: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&response).map_err(|e| format!("parse: {e}"))
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn request(socket: &Path, value: &Value) -> Result<Value, String> {
    windows::request(socket, value)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    fn temp(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "authority-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    struct Running {
        socket: PathBuf,
        runs: PathBuf,
        token: String,
    }

    fn start(label: &str) -> Running {
        let runs = temp(label);
        fs::create_dir_all(&runs).unwrap();
        let socket = runs.join(META_DIR).join(SOCKET_NAME);
        let token = format!("test-token-{}-{}", label, "x".repeat(40));
        let config = AuthorityConfig {
            socket_path: socket.clone(),
            runs_dir: runs.clone(),
            token: token.clone(),
            expected_uid: unsafe { libc::geteuid() },
        };
        std::thread::spawn(move || {
            let _ = serve(config);
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !socket.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(socket.exists(), "authority socket was not created");
        Running {
            socket,
            runs,
            token,
        }
    }

    fn call(running: &Running, op: Value) -> Value {
        let mut request = op;
        request["v"] = json!(PROTOCOL_VERSION);
        request["token"] = json!(running.token);
        if request.get("ownerId").is_none() {
            request["ownerId"] = json!("test-owner");
        }
        super::request(&running.socket, &request).expect("socket roundtrip")
    }

    #[test]
    fn authenticated_roundtrip_and_ops() {
        let running = start("roundtrip");
        let health = call(&running, json!({"op":"health"}));
        assert_eq!(health["ok"], true);
        assert_eq!(health["stateAuthority"], "rust");

        let acquired = call(
            &running,
            json!({"op":"acquire","runId":"r1","ownerId":"test-owner","ttlMs":600000}),
        );
        assert_eq!(acquired["ok"], true);
        let epoch = acquired["epoch"].as_u64().unwrap();

        let created = call(
            &running,
            json!({
                "op":"create","runId":"r1","epoch":epoch,
                "state":{"runId":"r1","task":"demo","runState":"PLANNED","phases":[{"n":1}],"workers":["alpha"]}
            }),
        );
        assert_eq!(created["ok"], true, "{created}");

        let read = call(&running, json!({"op":"read","runId":"r1"}));
        assert_eq!(read["state"]["runState"], "PLANNED");
        let rev = read["rev"].as_u64().unwrap();

        let mut next = read["state"].clone();
        next["runState"] = json!("RUNNING");
        let applied = call(
            &running,
            json!({"op":"apply","runId":"r1","epoch":epoch,"expectedRev":rev,"state":next}),
        );
        assert_eq!(applied["ok"], true, "{applied}");

        let stale = call(
            &running,
            json!({"op":"apply","runId":"r1","epoch":epoch,"expectedRev":rev,"state":next}),
        );
        assert_eq!(stale["ok"], false);
        assert_eq!(stale["error"], "STALE_REV");
        assert_eq!(stale["currentRev"], rev + 1);

        let snap = call(&running, json!({"op":"snapshot","limit":10}));
        assert_eq!(snap["ok"], true);
        assert_eq!(snap["runs"][0]["runId"], "r1");
        assert_eq!(snap["runs"][0]["stateAuthority"], "rust");

        let _ = fs::remove_dir_all(&running.runs);
    }

    #[test]
    fn token_and_protocol_are_enforced() {
        let running = start("auth");
        let mut bad = json!({"v": PROTOCOL_VERSION, "op":"health", "token":"wrong"});
        let refused = super::request(&running.socket, &bad).unwrap();
        assert_eq!(refused["error"], "UNAUTHORIZED");
        bad["token"] = json!(running.token);
        bad["v"] = json!(99);
        let refused = super::request(&running.socket, &bad).unwrap();
        assert_eq!(refused["error"], "PROTOCOL_VERSION");
        // Unknown run ids never escape the runs directory.
        let escape = call(&running, json!({"op":"read","runId":"../etc"}));
        assert_eq!(escape["error"], "INVALID_RUN_ID");
        let _ = fs::remove_dir_all(&running.runs);
    }
}
