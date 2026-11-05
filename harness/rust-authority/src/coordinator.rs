// coordinator.rs — read-only coordinator state view for the Harness Control Center.
//
// This listener is READ-ONLY by construction (every non-GET method is refused),
// which is exactly what the dashboard should hold: a browser surface must never
// be able to mutate run state. The write authority lives in `authority.rs` on a
// peer-credential-checked Unix socket that only the coordinator may use.
//
// It projects the `runs/` tree (state.json written by the Rust authority, the
// authority revision file and coordinator slot locks) into one versioned,
// bounded, authenticated JSON read model.
//
// Safety properties:
//   * read-only: the HTTP server rejects every non-GET method (405);
//   * fail closed: it refuses to start without an explicit runs directory and a
//     token of at least 32 characters;
//   * bounded: max runs scanned, max state file size, max string fields, no
//     transcripts, prompts or credentials are read;
//   * loopback only: a non-loopback bind address is refused.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub const SNAPSHOT_SCHEMA: &str = "orchestra-coordinator-read/1";
pub const MAX_RUNS_SCAN: usize = 1000;
pub const MAX_STATE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_RUNS_RETURNED: usize = 200;
const MAX_TASK_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 120;
const MAX_ERROR_CHARS: usize = 300;

/// One projected run record. Unknown state.json keys are ignored; the raw file
/// remains the authority for every other consumer.
#[derive(Debug, Clone)]
pub struct RunView {
    pub run_id: String,
    pub run_number: Option<u64>,
    pub title: Option<String>,
    pub task: Option<String>,
    pub state: String,
    pub mode: Option<String>,
    pub current_phase: Option<u64>,
    pub completed_through: u64,
    pub phases: u64,
    pub workers: Vec<String>,
    pub started_at: Option<i64>,
    pub final_verdict: Option<String>,
    pub last_error: Option<String>,
    pub blocked_at_phase: Option<u64>,
    pub rev: Option<u64>,
    pub epoch: Option<u64>,
    pub journal_records: Option<u64>,
    pub lease_active: bool,
    pub state_authority: String,
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max) {
        out.push(ch);
    }
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// Removes values that must never reach a dashboard payload. This is a
/// defensive projection, not a substitute for not writing secrets to state.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for marker in [
        "authorization:",
        "authorization=",
        "bearer ",
        "api_key=",
        "api-key=",
        "token=",
        "secret=",
        "password=",
    ] {
        let lower = out.to_lowercase();
        let mut search = 0usize;
        while let Some(pos) = lower[search..].find(marker) {
            let start = search + pos;
            let end = out[start..]
                .find(['\n', '\r', '"', '\''])
                .map(|offset| start + offset)
                .unwrap_or(out.len());
            let keep = marker.trim_end_matches([':', '=', ' ']).len() + 1;
            out.replace_range(start + keep..end, "[REDACTED]");
            search = start + keep;
            if search >= out.len() {
                break;
            }
        }
    }
    out
}

fn opt_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn opt_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn workers_of(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .take(32)
                .collect()
        })
        .unwrap_or_default()
}

/// Reads one state.json and projects the fields the Control Center needs.
/// A malformed or oversized file yields `None` and is counted, never panics.
pub fn read_run(run_dir: &Path) -> Option<RunView> {
    let path = run_dir.join("state.json");
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > MAX_STATE_BYTES {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if !value.is_object() {
        return None;
    }
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| run_dir.file_name()?.to_str().map(str::to_string))?;
    let state = value
        .get("runState")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_string();
    let final_verdict = value
        .get("finalAcceptance")
        .and_then(|v| v.get("verdict"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // Authority metadata is written by the Rust authority only. A run without
    // it predates the cutover (or has not been adopted yet) and is reported as
    // unmanaged rather than guessed at.
    let authority: Option<Value> = fs::read_to_string(run_dir.join("authority.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let lease_expires = authority
        .as_ref()
        .and_then(|a| a.get("leaseExpiresAtMs"))
        .and_then(Value::as_u64);
    Some(RunView {
        run_id,
        run_number: opt_u64(value.get("runNumber")),
        title: opt_string(value.get("runTitle"))
            .map(|s| truncate_chars(&scrub(&s), MAX_TITLE_CHARS)),
        task: opt_string(value.get("task")).map(|s| truncate_chars(&scrub(&s), MAX_TASK_CHARS)),
        state,
        mode: opt_string(value.get("mode")),
        current_phase: opt_u64(value.get("currentPhase")),
        completed_through: opt_u64(value.get("completedThrough")).unwrap_or(0),
        phases: value
            .get("phases")
            .and_then(Value::as_array)
            .map(|p| p.len() as u64)
            .unwrap_or(0),
        workers: workers_of(value.get("workers")),
        started_at: value.get("startedAt").and_then(Value::as_i64),
        final_verdict,
        last_error: opt_string(value.get("lastError"))
            .map(|s| truncate_chars(&scrub(&s), MAX_ERROR_CHARS)),
        blocked_at_phase: opt_u64(value.get("blockedAtPhase")),
        rev: authority.as_ref().and_then(|a| opt_u64(a.get("rev"))),
        epoch: authority.as_ref().and_then(|a| opt_u64(a.get("epoch"))),
        journal_records: authority
            .as_ref()
            .and_then(|a| opt_u64(a.get("journalRecords"))),
        lease_active: lease_expires
            .map(|expires| expires > (Utc::now().timestamp_millis().max(0) as u64))
            .unwrap_or(false),
        state_authority: authority
            .as_ref()
            .and_then(|a| a.get("stateAuthority"))
            .and_then(Value::as_str)
            .unwrap_or("unmanaged")
            .to_string(),
    })
}

/// Process liveness using /proc. Existence is never liveness: a zombie or an
/// empty cmdline counts as dead.
fn process_alive(pid: u64) -> bool {
    let proc_dir = PathBuf::from(format!("/proc/{pid}"));
    let stat = match fs::read_to_string(proc_dir.join("stat")) {
        Ok(s) => s,
        Err(_) => return false,
    };
    // state is field 3, after the parenthesised comm (which may contain spaces).
    let state = stat
        .rfind(')')
        .and_then(|i| stat[i + 1..].split_whitespace().next())
        .unwrap_or("");
    if state == "Z" || state.is_empty() {
        return false;
    }
    fs::read(proc_dir.join("cmdline"))
        .map(|bytes| !bytes.is_empty())
        .unwrap_or(false)
}

fn cmdline(pid: u64) -> String {
    fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| String::from_utf8_lossy(&bytes).replace('\0', " "))
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
pub struct LockView {
    pub file: String,
    pub pid: Option<u64>,
    pub alive: bool,
    pub js_coordinator: bool,
}

fn read_lock(runs_dir: &Path, name: &str) -> Option<LockView> {
    let text = fs::read_to_string(runs_dir.join(name)).ok()?;
    let pid = text.trim().parse::<u64>().ok();
    let alive = pid.map(process_alive).unwrap_or(false);
    let js_coordinator = pid
        .filter(|_| alive)
        .map(|p| cmdline(p).contains("orchestrate.mjs"))
        .unwrap_or(false);
    Some(LockView {
        file: name.to_string(),
        pid,
        alive,
        js_coordinator,
    })
}

pub struct SnapshotOptions {
    pub runs_dir: PathBuf,
    pub max_runs: usize,
    pub now: DateTime<Utc>,
}

impl SnapshotOptions {
    pub fn new(runs_dir: impl Into<PathBuf>) -> Self {
        Self {
            runs_dir: runs_dir.into(),
            max_runs: MAX_RUNS_SCAN,
            now: Utc::now(),
        }
    }
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn duration_ms(started_at: Option<i64>, now: DateTime<Utc>) -> Option<i64> {
    let started = started_at?;
    let now_ms = now.timestamp_millis();
    if started <= 0 || now_ms < started {
        return None;
    }
    Some(now_ms - started)
}

/// Builds the bounded read model. Missing, unreadable or corrupt entries are
/// reported as counters rather than failing the whole snapshot.
pub fn snapshot(options: &SnapshotOptions) -> Value {
    let mut runs: Vec<RunView> = Vec::new();
    let mut invalid = 0u64;
    let mut entries_read = 0usize;

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(&options.runs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.starts_with('.') || name == "consult" || name == "state" || name == "ACTIVE" {
                continue;
            }
            if !path.join("state.json").is_file() {
                continue;
            }
            dirs.push(path);
        }
    }
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    for dir in dirs.into_iter().take(options.max_runs.min(MAX_RUNS_SCAN)) {
        entries_read += 1;
        match read_run(&dir) {
            Some(run) => runs.push(run),
            None => invalid += 1,
        }
    }

    runs.sort_by_key(|a| std::cmp::Reverse(a.started_at.unwrap_or(0)));

    let mut by_state: Map<String, Value> = Map::new();
    for run in &runs {
        let entry = by_state
            .entry(run.state.clone())
            .or_insert_with(|| json!(0));
        if let Some(n) = entry.as_u64() {
            *entry = json!(n + 1);
        }
    }

    let active_states = ["PLANNED", "RUNNING"];
    let held_states = ["NEEDS_HUMAN_REVIEW", "REMEDIATION_EXHAUSTED"];
    let active = runs
        .iter()
        .filter(|r| active_states.contains(&r.state.as_str()))
        .count();
    let held = runs
        .iter()
        .filter(|r| held_states.contains(&r.state.as_str()))
        .count();
    let failed = runs
        .iter()
        .filter(|r| r.state == "ABORTED" || r.last_error.is_some())
        .count();

    let mut locks: Vec<LockView> = Vec::new();
    for name in [
        "COORDINATOR.lock",
        "COORDINATOR-1.lock",
        "COORDINATOR-2.lock",
        "COORDINATOR-3.lock",
        "COORDINATOR-4.lock",
    ] {
        if let Some(lock) = read_lock(&options.runs_dir, name) {
            locks.push(lock);
        }
    }
    let js_coordinators: Vec<Value> = locks
        .iter()
        .filter(|l| l.alive && l.js_coordinator)
        .filter_map(|l| l.pid)
        .map(|pid| json!({"pid": pid, "file": l_file(&locks, pid)}))
        .collect();

    let projected: Vec<Value> = runs
        .iter()
        .take(MAX_RUNS_RETURNED)
        .map(|run| {
            json!({
                "runId": run.run_id,
                "runNumber": run.run_number,
                "title": run.title,
                "task": run.task,
                "state": run.state,
                "mode": run.mode,
                "currentPhase": run.current_phase,
                "completedThrough": run.completed_through,
                "phases": run.phases,
                "workers": run.workers,
                "startedAt": run.started_at,
                "durationMs": duration_ms(run.started_at, options.now),
                "finalVerdict": run.final_verdict,
                "lastError": run.last_error,
                "blockedAtPhase": run.blocked_at_phase,
                "rev": run.rev,
                "epoch": run.epoch,
                "journalRecords": run.journal_records,
                "leaseActive": run.lease_active,
                "stateAuthority": run.state_authority,
            })
        })
        .collect();

    json!({
        "schema": SNAPSHOT_SCHEMA,
        "generatedAt": iso(options.now),
        "runtime": {
            "kind": "rust",
            "component": "coordinator-read",
            "readOnly": true,
            "stateAuthority": "rust",
            "authorityTransport": "unix-peercred",
            "note": "Rust owns run state; this HTTP surface is read-only, writes go through the authority socket",
        },
        "health": {
            "runsDir": options.runs_dir.display().to_string(),
            "runsDirReadable": options.runs_dir.is_dir(),
            "runsScanned": entries_read,
            "runsInvalid": invalid,
            "runCount": runs.len(),
            "activeRuns": active,
            "heldRuns": held,
            "failedRuns": failed,
            "jsCoordinators": js_coordinators,
            "rustManagedRuns": runs
                .iter()
                .filter(|r| r.state_authority == "rust")
                .count(),
            "activeLeases": runs.iter().filter(|r| r.lease_active).count(),
        },
        "counts": { "byState": by_state },
        "locks": locks.iter().map(|l| json!({
            "file": l.file,
            "pid": l.pid,
            "alive": l.alive,
            "jsCoordinator": l.js_coordinator,
        })).collect::<Vec<_>>(),
        "runs": projected,
    })
}

fn l_file(locks: &[LockView], pid: u64) -> String {
    locks
        .iter()
        .find(|l| l.pid == Some(pid))
        .map(|l| l.file.clone())
        .unwrap_or_default()
}

/// Constant-time-ish token check. Length mismatch fails before comparison.
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

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let mut response = Response::from_data(payload).with_status_code(StatusCode(status));
    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]) {
        response.add_header(header);
    }
    response
}

fn unauthorized() -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(401, &json!({"ok": false, "error": "unauthorized"}))
}

fn not_found() -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(404, &json!({"ok": false, "error": "not_found"}))
}

/// Reads one buffered request body with a hard bound. Returns None when the
/// declared or actual size exceeds `limit`.
fn read_body(request: &mut Request, limit: usize) -> Option<String> {
    if let Some(len) = request.body_length() {
        if len > limit {
            return None;
        }
    }
    let mut buffer = Vec::new();
    let reader = request.as_reader();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if buffer.len() > limit {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    String::from_utf8(buffer).ok()
}

/// Serves the read-only snapshot API. Every non-GET method is refused before
/// routing, so this server can never mutate run state.
pub fn serve(addr: &str, runs_dir: PathBuf, token: String) -> Result<(), String> {
    if !addr.starts_with("127.0.0.1:") && !addr.starts_with("[::1]:") {
        return Err("coord-serve refuses a non-loopback bind address".into());
    }
    if token.len() < 32 {
        return Err("ORCHESTRA_COORD_TOKEN must be at least 32 characters".into());
    }
    let server = Server::http(addr).map_err(|e| format!("bind {addr}: {e}"))?;
    eprintln!("orchestra coordinator-read listening on http://{addr} (read-only)");
    for mut request in server.incoming_requests() {
        if request.method() != &Method::Get {
            let body = read_body(&mut request, 64 * 1024);
            let _ = body;
            let _ = request.respond(json_response(
                405,
                &json!({"ok": false, "error": "read_only_runtime"}),
            ));
            continue;
        }
        let presented = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().trim().to_string())
            .and_then(|v| v.strip_prefix("Bearer ").map(str::to_string))
            .unwrap_or_default();
        if !token_matches(&token, &presented) {
            let _ = request.respond(unauthorized());
            continue;
        }
        let path = request.url().split('?').next().unwrap_or("/").to_string();
        let response = match path.as_str() {
            "/v1/health" => json_response(
                200,
                &json!({
                    "ok": true,
                    "schema": SNAPSHOT_SCHEMA,
                    "readOnly": true,
                    "stateAuthority": "rust",
                    "authorityTransport": "unix-peercred",
                    "runsDir": runs_dir.display().to_string(),
                    "generatedAt": iso(Utc::now()),
                }),
            ),
            "/v1/snapshot" => json_response(200, &snapshot(&SnapshotOptions::new(&runs_dir))),
            "/v1/runs" => {
                let snap = snapshot(&SnapshotOptions::new(&runs_dir));
                json_response(
                    200,
                    &json!({"ok": true, "runs": snap["runs"].clone(), "counts": snap["counts"].clone()}),
                )
            }
            "/v1/authority" => {
                let snap = snapshot(&SnapshotOptions::new(&runs_dir));
                let managed: Vec<Value> = snap["runs"]
                    .as_array()
                    .map(|runs| {
                        runs.iter()
                            .filter(|run| run["stateAuthority"] == json!("rust"))
                            .map(|run| {
                                json!({
                                    "runId": run["runId"],
                                    "state": run["state"],
                                    "rev": run["rev"],
                                    "epoch": run["epoch"],
                                    "journalRecords": run["journalRecords"],
                                    "leaseActive": run["leaseActive"],
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                json_response(
                    200,
                    &json!({
                        "ok": true,
                        "schema": SNAPSHOT_SCHEMA,
                        "stateAuthority": "rust",
                        "transport": "unix-peercred",
                        "managedRuns": managed.len(),
                        "totalRuns": snap["health"]["runCount"].clone(),
                        "activeRuns": snap["health"]["activeRuns"].clone(),
                        "activeLeases": managed.iter().filter(|r| r["leaseActive"] == json!(true)).count(),
                        "runs": managed,
                    }),
                )
            }
            other if other.starts_with("/v1/runs/") => {
                let id = &other["/v1/runs/".len()..];
                if id.is_empty() || id.contains('/') || id.contains("..") {
                    json_response(400, &json!({"ok": false, "error": "invalid_run_id"}))
                } else {
                    let snap = snapshot(&SnapshotOptions::new(&runs_dir));
                    match snap["runs"]
                        .as_array()
                        .and_then(|runs| runs.iter().find(|r| r["runId"] == json!(id)).cloned())
                    {
                        Some(run) => json_response(200, &json!({"ok": true, "run": run})),
                        None => not_found(),
                    }
                }
            }
            _ => not_found(),
        };
        let _ = request.respond(response);
    }
    Ok(())
}

pub fn state_dir_from_env() -> Result<PathBuf, String> {
    let value = std::env::var("ORCHESTRA_RUNS_DIR")
        .map_err(|_| "ORCHESTRA_RUNS_DIR must be set explicitly for coord-serve".to_string())?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("ORCHESTRA_RUNS_DIR must be an absolute path".into());
    }
    Ok(path)
}

pub fn token_from_env() -> Result<String, String> {
    if let Ok(token) = std::env::var("ORCHESTRA_COORD_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(token.trim().to_string());
        }
    }
    let file = std::env::var("ORCHESTRA_COORD_TOKEN_FILE")
        .map_err(|_| "set ORCHESTRA_COORD_TOKEN or ORCHESTRA_COORD_TOKEN_FILE".to_string())?;
    fs::read_to_string(&file)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read token file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "coord-{label}-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_run(root: &Path, id: &str, state: Value) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
    }

    #[test]
    fn projects_runs_and_counts_states() {
        let root = temp_root("counts");
        write_run(
            &root,
            "r1",
            json!({"runId":"r1","runState":"RUNNING","task":"do work","workers":["alpha"],"completedThrough":1,"phases":[{"n":1}],"startedAt":1_700_000_000_000i64}),
        );
        write_run(
            &root,
            "r2",
            json!({"runId":"r2","runState":"COMPLETED","task":"done","startedAt":1_700_000_100_000i64,"finalAcceptance":{"verdict":"ACCEPTED"}}),
        );
        let snap = snapshot(&SnapshotOptions::new(&root));
        assert_eq!(snap["schema"], SNAPSHOT_SCHEMA);
        assert_eq!(snap["health"]["runCount"], 2);
        assert_eq!(snap["health"]["activeRuns"], 1);
        assert_eq!(snap["counts"]["byState"]["RUNNING"], 1);
        assert_eq!(snap["counts"]["byState"]["COMPLETED"], 1);
        // newest first
        assert_eq!(snap["runs"][0]["runId"], "r2");
        assert_eq!(snap["runs"][0]["finalVerdict"], "ACCEPTED");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_and_oversized_state_is_counted_not_fatal() {
        let root = temp_root("corrupt");
        let dir = root.join("bad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.json"), b"{not json").unwrap();
        write_run(&root, "ok", json!({"runId":"ok","runState":"RUNNING"}));
        let snap = snapshot(&SnapshotOptions::new(&root));
        assert_eq!(snap["health"]["runsInvalid"], 1);
        assert_eq!(snap["health"]["runCount"], 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounds_scan_and_string_fields() {
        let root = temp_root("bounds");
        for i in 0..6 {
            write_run(
                &root,
                &format!("r{i}"),
                json!({"runId":format!("r{i}"),"runState":"RUNNING","task":"x".repeat(5000),"startedAt":1_700_000_000_000i64 + i}),
            );
        }
        let mut options = SnapshotOptions::new(&root);
        options.max_runs = 3;
        let snap = snapshot(&options);
        assert_eq!(snap["health"]["runsScanned"], 3);
        let task = snap["runs"][0]["task"].as_str().unwrap();
        assert!(task.chars().count() <= MAX_TASK_CHARS + 1);
        assert!(task.ends_with('…'));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scrubs_secret_shaped_values() {
        let text = "request failed authorization: Bearer abcdef123456 and api_key=supersecret";
        let cleaned = scrub(text);
        assert!(!cleaned.contains("abcdef123456"));
        assert!(!cleaned.contains("supersecret"));
        assert!(cleaned.contains("[REDACTED]"));
    }

    #[test]
    fn live_lock_reports_pid_and_js_flag() {
        let root = temp_root("locks");
        fs::create_dir_all(&root).unwrap();
        let pid = std::process::id();
        fs::write(root.join("COORDINATOR-1.lock"), pid.to_string()).unwrap();
        fs::write(root.join("COORDINATOR-2.lock"), "not-a-pid").unwrap();
        let snap = snapshot(&SnapshotOptions::new(&root));
        let locks = snap["locks"].as_array().unwrap();
        let first = locks
            .iter()
            .find(|l| l["file"] == "COORDINATOR-1.lock")
            .unwrap();
        assert_eq!(first["alive"], true);
        assert_eq!(first["jsCoordinator"], false); // test binary is not orchestrate.mjs
        let second = locks
            .iter()
            .find(|l| l["file"] == "COORDINATOR-2.lock")
            .unwrap();
        assert_eq!(second["alive"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn token_comparison_is_exact() {
        assert!(token_matches(
            "a".repeat(32).as_str(),
            "a".repeat(32).as_str()
        ));
        assert!(!token_matches(
            "a".repeat(32).as_str(),
            "a".repeat(31).as_str()
        ));
        assert!(!token_matches("", ""));
    }

    #[test]
    fn run_id_lookup_shape_is_stable() {
        let root = temp_root("lookup");
        write_run(&root, "abc", json!({"runId":"abc","runState":"RUNNING"}));
        let snap = snapshot(&SnapshotOptions::new(&root));
        assert_eq!(snap["runs"][0]["runId"], "abc");
        assert_eq!(snap["runs"][0]["phases"], 0);
        assert_eq!(snap["runs"][0]["workers"], json!([]));
        let _ = fs::remove_dir_all(root);
    }
}
