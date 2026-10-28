use chrono::{DateTime, Duration, Utc};
use fs2::FileExt;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub const MAX_EVENT_BYTES: usize = 2048;
pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const RETENTION_DAYS: i64 = 14;

// Allowlists deliberately exclude prompt, response, tool body, command, path and secrets.
const FIELDS: &[&str] = &[
    "timestamp",
    "kind",
    "runId",
    "sessionId",
    "component",
    "role",
    "purpose",
    "agent",
    "mode",
    "stage",
    "engine",
    "model",
    "provider",
    "billingClass",
    "attempt",
    "success",
    "failureClass",
    "rc",
    "paid",
    "visionUsed",
    "freebucksUsed",
    "durationMs",
    "fallbackFrom",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
    "costSource",
    "reviewVerdict",
    "result",
    "parentRunId",
];

// Format constraints are intentionally shared with adapter/telemetry-transport.mjs.
// A field allowlist alone is not sufficient: an arbitrary short value such as
// "customer token=..." must never become a persisted model/agent label.
const IDS: &[&str] = &["runId", "sessionId", "parentRunId"];
const NONNEGATIVE_INTS: &[&str] = &[
    "attempt",
    "freebucksUsed",
    "durationMs",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
];
const BOOLEAN_FIELDS: &[&str] = &["success", "paid", "visionUsed"];

fn ascii_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn ascii_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'#' | b'-')
        })
}
fn ascii_kind(s: &str) -> bool {
    s.len() <= 64
        && !s.is_empty()
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn typed_scalar(field: &str, value: &Value) -> Option<Value> {
    if field == "timestamp" {
        return None;
    } // server timestamps are authoritative
    if IDS.contains(&field) {
        return value.as_str().filter(|s| ascii_id(s)).map(|s| json!(s));
    }
    if field == "kind" {
        return value.as_str().filter(|s| ascii_kind(s)).map(|s| json!(s));
    }
    if NONNEGATIVE_INTS.contains(&field) {
        return value
            .as_u64()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .map(|v| json!(v));
    }
    if field == "rc" {
        return value
            .as_i64()
            .filter(|v| v.abs_diff(0) <= 9_007_199_254_740_991)
            .map(|v| json!(v));
    }
    if field == "costUsd" {
        return value
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| json!(v));
    }
    if BOOLEAN_FIELDS.contains(&field) {
        return value.as_bool().map(|v| json!(v));
    }
    value.as_str().filter(|s| ascii_label(s)).map(|s| json!(s))
}

pub fn sanitize(v: &Value) -> Result<Value, String> {
    let obj = v.as_object().ok_or("event must be a JSON object")?;
    let mut out = Map::new();
    for field in FIELDS {
        if let Some(value) = obj.get(*field).and_then(|v| typed_scalar(field, v)) {
            out.insert((*field).to_owned(), value);
        }
    }
    if !out.contains_key("kind") && !out.contains_key("engine") {
        return Err("event requires a valid kind or engine".into());
    }
    if !out.contains_key("kind") {
        out.insert("kind".into(), json!("model_invocation"));
    }
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    out.insert("timestamp".into(), json!(now));
    let encoded = serde_json::to_vec(&out).map_err(|e| e.to_string())?;
    if encoded.len() > MAX_EVENT_BYTES {
        return Err("event exceeds hard payload limit".into());
    }
    Ok(Value::Object(out))
}

#[derive(Clone, Debug)]
pub struct Store {
    pub directory: PathBuf,
    pub max_bytes: u64,
    pub retention_days: i64,
}

impl Store {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        Self {
            directory: directory.as_ref().to_path_buf(),
            max_bytes: DEFAULT_MAX_BYTES,
            retention_days: RETENTION_DAYS,
        }
    }

    fn lock(&self) -> std::io::Result<File> {
        fs::create_dir_all(&self.directory)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.directory.join(".lock"))?;
        file.lock_exclusive()?;
        Ok(file)
    }

    fn segments(&self) -> std::io::Result<Vec<(PathBuf, u64)>> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let p = entry.path();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("events-") && name.ends_with(".jsonl") && p.is_file() {
                    result.push((p.clone(), entry.metadata()?.len()));
                }
            }
        }
        result.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(result)
    }

    fn prune_locked(&self, upcoming: u64) -> std::io::Result<bool> {
        // Daily rollups are not yet implemented. This is bounded event retention only.
        let cutoff = Utc::now().date_naive() - Duration::days(self.retention_days);
        let mut files = self.segments()?;
        for (p, _) in &files {
            let expired = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("events-"))
                .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .map(|d| d < cutoff)
                .unwrap_or(true);
            if expired {
                fs::remove_file(p)?;
            }
        }
        files = self.segments()?;
        let mut total: u64 = files.iter().map(|(_, size)| *size).sum();
        // Remove old complete days, never unlink the active file being appended.
        let today = format!("events-{}.jsonl", Utc::now().format("%Y-%m-%d"));
        for (p, size) in files {
            if total.saturating_add(upcoming) <= self.max_bytes {
                break;
            }
            if p.file_name().and_then(|s| s.to_str()) != Some(today.as_str()) {
                fs::remove_file(p)?;
                total = total.saturating_sub(size);
            }
        }
        Ok(total.saturating_add(upcoming) <= self.max_bytes)
    }

    pub fn record(&self, raw: &Value) -> Result<bool, String> {
        let event = sanitize(raw)?;
        let line = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
        let _guard = self.lock().map_err(|e| e.to_string())?;
        if !self
            .prune_locked((line.len() + 1) as u64)
            .map_err(|e| e.to_string())?
        {
            return Ok(false); // Dropped rather than disrupting orchestration.
        }
        let path = self
            .directory
            .join(format!("events-{}.jsonl", Utc::now().format("%Y-%m-%d")));
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(&line)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn read_since(&self, since: DateTime<Utc>, max_events: usize) -> Vec<Value> {
        let mut rows = VecDeque::new();
        let files = match self.segments() {
            Ok(files) => files,
            Err(_) => return Vec::new(),
        };
        for (path, _) in files {
            if let Ok(file) = File::open(path) {
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        let when = event
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                            .map(|t| t.with_timezone(&Utc));
                        if when.map(|t| t >= since).unwrap_or(false) {
                            rows.push_back(event);
                            if rows.len() > max_events {
                                rows.pop_front();
                            }
                        }
                    }
                }
            }
        }
        rows.into_iter().collect()
    }

    pub fn status(&self) -> Value {
        let segments = self.segments().unwrap_or_default();
        json!({
            "storageBytes": segments.iter().map(|(_, s)| *s).sum::<u64>(),
            "budgetBytes": self.max_bytes,
            "retentionDays": self.retention_days,
            "eventFiles": segments.len(),
            "telemetryOnly": true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sanitize_is_strict_and_bounded() {
        let obj = json!({"engine":"sol", "success":true, "runId":"r1", "prompt":"secret", "toolOutput":"secret"});
        let clean = sanitize(&obj).unwrap();
        assert!(clean.get("prompt").is_none());
        assert!(clean.get("toolOutput").is_none());
        assert_eq!(clean["engine"], "sol");
        assert!(
            sanitize(&json!({"kind":"model_invocation","engine":"sol"}))
                .unwrap()
                .get("success")
                .is_none(),
            "unknown model outcome must not be misreported as failure"
        );
        assert_eq!(
            sanitize(&json!({"kind":"model_invocation","engine":"sol","success":false})).unwrap()
                ["success"],
            false
        );
        assert!(sanitize(&json!({"note":"none"})).is_err());
        assert!(sanitize(&json!({"kind":"secret text with spaces"})).is_err());
        assert!(sanitize(&json!({"engine":"token=secret"})).is_err());
        let restricted = sanitize(&json!({"kind":"run_started", "runId":"../../secrets",
            "engine":"provider", "agent":"customer token=private", "durationMs":-1,
            "inputTokens":2.5, "costUsd":-7, "success":"yes"}))
        .unwrap();
        assert!(restricted.get("runId").is_none());
        assert!(restricted.get("agent").is_none());
        assert!(restricted.get("durationMs").is_none());
        assert!(restricted.get("inputTokens").is_none());
        assert!(restricted.get("costUsd").is_none());
        assert!(restricted.get("success").is_none());
        assert_eq!(restricted["kind"], "run_started");
    }
    #[test]
    fn simultaneous_writers_preserve_all_accepted_events() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-concurrent-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        let store = Store::new(&dir);
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let s = store.clone();
                std::thread::spawn(move || {
                    for j in 0..25 {
                        assert!(s
                            .record(&json!({"engine":"test","attempt":j,"runId":format!("run{i}")}))
                            .unwrap());
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let rows = store.read_since(Utc::now() - Duration::minutes(5), 300);
        assert_eq!(rows.len(), 200);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn recent_read_keeps_last_n_without_corrupting_order() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-recent-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        let store = Store::new(&dir);
        for i in 0..10 {
            assert!(store
                .record(&json!({"kind":"run_started","runId":format!("r{i}")}))
                .unwrap());
        }
        let rows = store.read_since(Utc::now() - Duration::hours(1), 3);
        let ids: Vec<_> = rows
            .iter()
            .filter_map(|r| r.get("runId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["r7", "r8", "r9"]);
        assert!(store
            .read_since(Utc::now() - Duration::hours(1), 0)
            .is_empty());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn write_summary_and_budget() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-rust-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let mut store = Store::new(&dir);
        store.max_bytes = 4096;
        assert!(store
            .record(&json!({"engine":"worker", "success":true}))
            .unwrap());
        let rows = store.read_since(Utc::now() - Duration::hours(1), 20);
        assert_eq!(rows.len(), 1);
        store.max_bytes = 1;
        assert!(!store.record(&json!({"engine":"worker"})).unwrap());
        let _ = fs::remove_dir_all(dir);
    }
}
