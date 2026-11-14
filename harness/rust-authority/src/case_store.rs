//! Candidate native Rust port of kit/lib/case-store.mjs.
//!
//! The persisted case JSON format and ops.jsonl format follow the source JS.
//! All write operations are serialized through the existing case.lock directory.
//! This is NOT approved for concurrent mixed JS/Rust journal writers: the JS
//! journal append/complete paths do not acquire case.lock. Never cut over
//! shared journal writes until all actors use one writer implementation.
use chrono::Utc;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const LOCK_RETRIES: u32 = 40;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn temp_path(path: &Path) -> PathBuf {
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!(
        "{}.tmp-{}-{suffix}",
        path.display(),
        std::process::id()
    ))
}

fn sync_parent(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(parent) = _path.parent() {
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// On Windows, std::fs::rename cannot replace an existing destination. Use
// the Win32 ReplaceFileW primitive for existing journal/state projections.
// No remove-then-rename gap is permitted: if replacement fails, keep the old
// authoritative file intact and return an error to the caller.
#[cfg(windows)]
fn commit_temp(temp: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    if !path.exists() {
        // First creation is exclusive: concurrent appearance of a target
        // fails rather than destroying a file we have not inspected.
        return fs::rename(temp, path).map_err(|e| e.to_string());
    }
    let wide = |p: &Path| -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let target = wide(path);
    let source = wide(temp);
    let rc = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if rc == 0 {
        Err(format!(
            "STATE_ATOMIC_REPLACE_FAILED: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn commit_temp(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(|e| e.to_string())
}

pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let temp = temp_path(path);
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // ReplaceFileW needs the replacement's write handle closed first.
        drop(file);
        commit_temp(&temp, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

// Intentionally no timestamp-based lock stealing. A suspended live writer can
// outlast any arbitrary stale threshold; deleting its lock lets two writers
// mutate the same journal. Recovery requires external ownership verification
// and an operator-led action, never a guessed PID or file age.

struct CaseLock {
    path: PathBuf,
    owner_bytes: Vec<u8>,
}
impl Drop for CaseLock {
    fn drop(&mut self) {
        if fs::read(self.path.join("owner")).ok().as_deref() == Some(self.owner_bytes.as_slice()) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn acquire_lock(dir: &Path) -> Result<CaseLock, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("case.lock");
    for i in 0..LOCK_RETRIES {
        match fs::create_dir(&path) {
            Ok(()) => {
                let owner_bytes = json!({"pid":std::process::id(),"at":now_ms(),
                    "token":format!("{}-{}", std::process::id(), TEMP_SEQUENCE.fetch_add(1,Ordering::Relaxed))}).to_string().into_bytes();
                let owner = path.join("owner");
                if let Err(error) = fs::write(&owner, &owner_bytes) {
                    let _ = fs::remove_dir_all(&path);
                    return Err(error.to_string());
                }
                return Ok(CaseLock { path, owner_bytes });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Fail closed even if the lock is old or its reported PID is
                // absent: neither fact proves this lock is safe to delete.
                thread::sleep(Duration::from_millis(50 * (i + 1).min(10) as u64));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("LOCK_TIMEOUT".to_owned())
}

#[cfg(test)]
fn read_case(dir: &Path) -> Option<Value> {
    fs::read(dir.join("case.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
}

/// Fail-closed read for a write transaction; never replace malformed state.
fn checked_case(dir: &Path) -> Result<Option<Value>, String> {
    match fs::read(dir.join("case.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("CASE_STATE_UNAVAILABLE: {e}")),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => Ok(Some(v)),
            _ => Err("CORRUPT_CASE_STATE: refusing replacement".into()),
        },
    }
}

/// Check journal while holding the native case mutex. Read-only report methods
/// retain their tolerant behavior, but journal mutation never rewrites a
/// malformed record into a new authoritative form.
fn checked_journal(dir: &Path) -> Result<Vec<Value>, String> {
    let bytes = match fs::read(dir.join("ops.jsonl")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("JOURNAL_UNAVAILABLE: {e}")),
        Ok(bytes) => bytes,
    };
    let mut rows = Vec::new();
    for (i, line) in bytes.split(|c| *c == b'\n').enumerate() {
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(v) if v.is_object() => rows.push(v),
            _ => return Err(format!("CORRUPT_JOURNAL_STATE: line {}", i + 1)),
        }
    }
    Ok(rows)
}

/// CAS write, preserving the original rev/revAt/revWriter persisted shape.
/// A stale revision returns a structured decision and never writes.
/// Projection case.md is deliberately left to the JS compatibility adapter,
/// until the actual existing render callback has been migrated.
pub fn write_case(dir: &Path, expected_rev: Option<u64>, next: Value) -> Result<Value, String> {
    let _guard = acquire_lock(dir)?;
    let fresh = checked_case(dir)?;
    let disk_rev = fresh
        .as_ref()
        .and_then(|v| v.get("rev"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if expected_rev.is_some_and(|r| r != disk_rev) {
        return Ok(json!({"ok":false,"code":"stale","expectedRev":expected_rev,
            "diskRev":disk_rev,"case":fresh}));
    }
    let mut next = match next {
        Value::Object(map) => map,
        _ => return Ok(json!({"ok":false,"code":"bad-mutation"})),
    };
    let revision = disk_rev.checked_add(1).ok_or("revision overflow")?;
    next.insert("rev".into(), json!(revision));
    next.insert(
        "revAt".into(),
        json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    next.insert("revWriter".into(), json!(std::process::id()));
    let updated = Value::Object(next);
    let mut bytes = serde_json::to_vec_pretty(&updated).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    atomic_write(&dir.join("case.json"), &bytes)?;
    Ok(json!({"ok":true,"case":updated,"rev":revision}))
}

pub fn read_journal(dir: &Path) -> Vec<Value> {
    let file = match File::open(dir.join("ops.jsonl")) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    BufReader::new(file)
        .lines()
        .filter_map(|line| match line {
            Ok(s) if s.is_empty() => None,
            Ok(s) => Some(
                serde_json::from_str::<Value>(&s)
                    .unwrap_or_else(|_| json!({"opId":"?","state":"corrupt-line","raw":s})),
            ),
            Err(_) => Some(json!({"opId":"?","state":"corrupt-line","raw":"read error"})),
        })
        .collect()
}

pub fn pending_intents(dir: &Path) -> Vec<Value> {
    read_journal(dir)
        .into_iter()
        .filter(|v| v.get("state") == Some(&json!("pending")))
        .collect()
}

/// Durable intent must exist before calling an external provider. This
/// function returns an error on all persistence failures, never success.
pub fn journal_intent(dir: &Path, intent: &Value) -> Result<Value, String> {
    let op_id = intent
        .get("opId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("journalIntent: opId and op are required")?;
    let op = intent
        .get("op")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("journalIntent: opId and op are required")?;
    let _guard = acquire_lock(dir)?;
    checked_journal(dir)?;
    let entry = json!({"opId":op_id,"op":op,"caseId":intent.get("caseId").unwrap_or(&Value::Null),
        "phase":intent.get("phase").unwrap_or(&Value::Null),
        "requestDigest":intent.get("requestDigest").unwrap_or(&Value::Null),
        "state":"pending", "meta":intent.get("meta").unwrap_or(&Value::Null),
        "at":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join("ops.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{entry}").map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    sync_parent(&dir.join("ops.jsonl"))?;
    Ok(json!({"opId":op_id,"state":"pending"}))
}

pub fn journal_complete(dir: &Path, op_id: &str, update: &Value) -> Result<bool, String> {
    let state = update.get("state").and_then(Value::as_str).unwrap_or("");
    if !matches!(state, "done" | "failed" | "unknown") {
        return Err(format!("journalComplete: bad state {state}"));
    }
    let _guard = acquire_lock(dir)?;
    let mut records = checked_journal(dir)?;
    let mut found = false;
    for value in &mut records {
        if value.get("opId").and_then(Value::as_str) == Some(op_id)
            && value.get("state").and_then(Value::as_str) == Some("pending")
        {
            found = true;
            if let Some(map) = value.as_object_mut() {
                map.insert("state".into(), json!(state));
                for key in ["remoteId", "receipt", "errorClass"] {
                    map.insert(key.into(), update.get(key).cloned().unwrap_or(Value::Null));
                }
                map.insert(
                    "completedAt".into(),
                    json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                );
            }
        }
    }
    if !found {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    for item in records {
        bytes.extend_from_slice(
            serde_json::to_string(&item)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        );
        bytes.push(b'\n');
    }
    atomic_write(&dir.join("ops.jsonl"), &bytes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "orchestra-case-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }
    #[test]
    fn atomic_write_replaces_existing_bytes() {
        let root = dir("atomic-replace");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_preserves_old_bytes_when_replacement_is_blocked() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = dir("atomic-blocked");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        atomic_write(&path, b"old").unwrap();
        let blocker = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let error = atomic_write(&path, b"new").unwrap_err();
        assert!(error.starts_with("STATE_ATOMIC_REPLACE_FAILED:"));
        drop(blocker);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revision_compare_and_swap_blocks_stale() {
        let path = dir("cas");
        let a = write_case(&path, Some(0), json!({"task":"A"})).unwrap();
        assert_eq!(a["rev"], 1);
        let stale = write_case(&path, Some(0), json!({"task":"LOST"})).unwrap();
        assert_eq!(stale["code"], "stale");
        assert_eq!(read_case(&path).unwrap()["task"], "A");
        let b = write_case(&path, Some(1), json!({"task":"B"})).unwrap();
        assert_eq!(b["rev"], 2);
        let _ = fs::remove_dir_all(path);
    }
    #[test]
    fn journal_durable_pending_and_unknown() {
        let path = dir("journal");
        journal_intent(&path, &json!({"opId":"x","op":"post","caseId":"c1"})).unwrap();
        assert_eq!(pending_intents(&path).len(), 1);
        assert!(journal_complete(&path, "x", &json!({"state":"unknown"})).unwrap());
        assert_eq!(pending_intents(&path).len(), 0);
        assert_eq!(read_journal(&path)[0]["state"], "unknown");
        assert!(!journal_complete(&path, "does-not-exist", &json!({"state":"done"})).unwrap());
        let _ = fs::remove_dir_all(path);
    }
    #[test]
    fn unsupported_completion_is_rejected() {
        let path = dir("invalid");
        let err = journal_complete(&path, "x", &json!({"state":"completed"})).unwrap_err();
        assert!(err.contains("bad state"));
        let _ = fs::remove_dir_all(path);
    }
    #[test]
    fn parallel_writers_observe_monotonic_revisions() {
        let path = dir("parallel");
        let mut handles = Vec::new();
        for _ in 0..8 {
            let path = path.clone();
            handles.push(thread::spawn(move || {
                write_case(&path, Some(0), json!({"status":"started"}))
            }));
        }
        let succeeded = handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .filter(|v| v["ok"] == true)
            .count();
        assert_eq!(succeeded, 1);
        assert_eq!(read_case(&path).unwrap()["rev"], 1);
        let _ = fs::remove_dir_all(path);
    }
}
