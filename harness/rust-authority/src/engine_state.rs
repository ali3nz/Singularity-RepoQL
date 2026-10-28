//! Rust candidate for kit/lib/engine-state.mjs.
//!
//! Persistent availability state and hard-disabled Claude policy. The file
//! shape is compatible with engine-state.json, but this module has not been
//! differential-tested against the JS implementation. Never permit mixed
//! writers before cross-process compatibility testing.
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};

const DEFAULT_ENGINE: &str = r#"{"state":"available","retryAt":null,"cooldownUntil":null,"consecutiveTransientFailures":0,"lastSuccess":null,"lastFailure":null,"enabled":null,"roles":[],"billingClass":null,"visionCapable":null,"visionVerified":null,"automatic_implementation":null,"automatic_vision":null}"#;
const CLAUDE_REASON: &str = "subscription_retired_2026-09-20";
static NONCE: AtomicU64 = AtomicU64::new(1);

fn defaults() -> Value {
    serde_json::from_str(DEFAULT_ENGINE).expect("static JSON")
}
fn disabled() -> Value {
    json!({"enabled":false,"disabledReason":CLAUDE_REASON,"billingClass":"disabled",
    "automatic_routing":false,"automatic_probe":false,"billing_allowed":false})
}

pub fn normalized(mut state: Value) -> Value {
    if !state.is_object() {
        state = json!({});
    }
    if !state.get("engines").is_some_and(Value::is_object) {
        state["engines"] = json!({});
    }
    let engines = state["engines"]
        .as_object_mut()
        .expect("initialized object");
    let base = defaults();
    for (_name, eng) in engines.iter_mut() {
        if !eng.is_object() {
            continue;
        }
        {
            if let Some(map) = eng.as_object_mut() {
                for key in [
                    "enabled",
                    "roles",
                    "billingClass",
                    "visionCapable",
                    "visionVerified",
                    "automatic_implementation",
                    "automatic_vision",
                ] {
                    if !map.contains_key(key) {
                        map.insert(key.to_string(), base[key].clone());
                    }
                }
            }
        }
    }
    let old = engines.get("claude").cloned().unwrap_or(json!({}));
    let mut claude = if old.is_object() { old } else { json!({}) };
    let old_last = claude
        .get("lastFailure")
        .filter(|v| !v.is_null() && v.as_str() != Some(""))
        .cloned();
    let new = disabled();
    for (key, v) in new.as_object().expect("object") {
        claude[key] = v.clone();
    }
    claude["state"] = json!("disabled");
    claude["retryAt"] = Value::Null;
    claude["cooldownUntil"] = Value::Null;
    claude["lastFailure"] = old_last.unwrap_or(json!("2026-09-18T02:30:00Z"));
    engines.insert("claude".into(), claude);
    state["schemaVersion"] = json!(3);
    state
}

pub fn engine_snapshot(state: &Value, engine: &str) -> Value {
    if engine == "claude" {
        return normalized(state.clone())
            .pointer("/engines/claude")
            .cloned()
            .unwrap_or_else(disabled);
    }
    state
        .get("engines")
        .and_then(|v| v.get(engine))
        .cloned()
        .unwrap_or_else(defaults)
}

// Provider-availability predicate retained for the coordinator availability path.
// It is unit-tested here; the runtime that consumes it is not yet ported.
#[allow(dead_code)]
pub fn available_at(record: &Value, engine: &str, now: &DateTime<Utc>) -> bool {
    if engine == "claude" || record.get("enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    let parsed = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|date| date.with_timezone(&Utc))
    };
    if let Some(until) = parsed("cooldownUntil") {
        return *now >= until;
    }
    if record.get("state") == Some(&json!("exhausted")) {
        return parsed("retryAt").is_some_and(|reset| *now >= reset);
    }
    record.get("state") != Some(&json!("disabled"))
        && record.get("state") != Some(&json!("exhausted"))
}

pub struct EngineState {
    dir: PathBuf,
}
impl EngineState {
    pub fn new(runs_dir: impl AsRef<Path>) -> Self {
        Self {
            dir: runs_dir.as_ref().to_path_buf(),
        }
    }
    fn file(&self) -> PathBuf {
        self.dir.join("engine-state.json")
    }
    fn lockfile(&self) -> PathBuf {
        self.dir.join("engine-state.lock")
    }
    pub fn load(&self) -> Value {
        let raw = fs::read(self.file())
            .ok()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            .unwrap_or_else(|| json!({"schemaVersion":3,"engines":{}}));
        normalized(raw)
    }
    fn lock(&self) -> Result<EngineLock, String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let path = self.lockfile();
        for i in 0..50 {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let token = format!(
                        "{}-{}",
                        std::process::id(),
                        NONCE.fetch_add(1, Ordering::Relaxed)
                    );
                    if let Err(e) = file
                        .write_all(token.as_bytes())
                        .and_then(|_| file.sync_all())
                    {
                        let _ = fs::remove_file(&path);
                        return Err(e.to_string());
                    }
                    return Ok(EngineLock { path, token });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let expired = fs::metadata(&path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|at| SystemTime::now().duration_since(at).ok())
                        .is_some_and(|age| age > Duration::from_secs(10));
                    if expired {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    thread::sleep(Duration::from_millis([50, 150, 400, 900, 2000][i.min(4)]));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("ENGINE_STATE_LOCK_TIMEOUT".to_string())
    }
    pub fn mutate<F>(&self, engine: &str, action: F) -> Result<Value, String>
    where
        F: FnOnce(Value) -> Value,
    {
        if engine == "claude" {
            return Ok(engine_snapshot(&self.load(), "claude"));
        }
        let _guard = self.lock()?;
        // Validate the persisted state while under the native engine lock.
        // Silently defaulting a damaged file would erase previous opt-outs.
        match fs::read(self.file()) {
            Ok(bytes)
                if !matches!(
                    serde_json::from_slice::<Value>(&bytes),
                    Ok(Value::Object(_))
                ) =>
            {
                return Err("CORRUPT_ENGINE_STATE: refusing replacement".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("ENGINE_STATE_UNAVAILABLE: {e}"))
            }
            _ => {}
        }
        let mut state = self.load();
        let old = engine_snapshot(&state, engine);
        let next = action(old);
        if !next.is_object() {
            return Err("invalid engine mutation".into());
        }
        state["engines"][engine] = next.clone();
        state["updatedAt"] = json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let mut contents = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
        contents.push(b'\n');
        crate::case_store::atomic_write(&self.file(), &contents)?;
        Ok(next)
    }
    pub fn available(&self, engine: &str) -> Result<bool, String> {
        if engine == "claude" {
            return Ok(false);
        }
        let record = engine_snapshot(&self.load(), engine);
        if record.get("enabled") == Some(&Value::Bool(false)) {
            return Ok(false);
        }
        let now = Utc::now();
        let parse = |key: &str| {
            record
                .get(key)
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc))
        };
        if let Some(until) = parse("cooldownUntil") {
            if now < until {
                return Ok(false);
            }
            self.mutate(engine, |mut x| {
                x["cooldownUntil"] = Value::Null;
                x["state"] = json!("available");
                x
            })?;
            return Ok(true);
        }
        if record["state"] == "exhausted" {
            if parse("retryAt").is_some_and(|at| now >= at) {
                self.mutate(engine, |mut x| {
                    x["state"] = json!("available");
                    x["retryAt"] = Value::Null;
                    x
                })?;
                return Ok(true);
            }
            return Ok(false);
        }
        Ok(record["state"] != "disabled")
    }
    pub fn mark_privacy_skip(&self, engine: &str) -> Result<Value, String> {
        let time = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.mutate(engine, |mut x| {
            x["lastFailure"] = json!(time);
            x
        })
    }
    pub fn mark_success(&self, engine: &str) -> Result<Value, String> {
        let time = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.mutate(engine, |mut x| {
            x["state"] = json!("available");
            x["retryAt"] = Value::Null;
            x["cooldownUntil"] = Value::Null;
            x["consecutiveTransientFailures"] = json!(0);
            x["lastSuccess"] = json!(time);
            x
        })
    }
    pub fn mark_auth_failure(&self, engine: &str) -> Result<Value, String> {
        self.fail_update(engine, "disabled", None)
    }
    pub fn mark_provider_down(&self, engine: &str) -> Result<Value, String> {
        self.fail_update(
            engine,
            "cooldown",
            Some(Utc::now() + ChronoDuration::minutes(30)),
        )
    }
    fn fail_update(
        &self,
        engine: &str,
        next_state: &str,
        until: Option<DateTime<Utc>>,
    ) -> Result<Value, String> {
        let time = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.mutate(engine, |mut x| {
            x["state"] = json!(next_state);
            x["lastFailure"] = json!(time);
            if let Some(t) = until {
                x["cooldownUntil"] = json!(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
            x
        })
    }
    pub fn mark_transient(&self, engine: &str) -> Result<Value, String> {
        let now = Utc::now();
        self.mutate(engine, |mut x| {
            let count = x["consecutiveTransientFailures"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(1);
            x["consecutiveTransientFailures"] = json!(count);
            x["cooldownUntil"] = if count >= 2 {
                json!((now + ChronoDuration::minutes(10))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            } else {
                Value::Null
            };
            x["lastFailure"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            x
        })
    }
    pub fn mark_quota_exhausted(
        &self,
        engine: &str,
        reset: Option<DateTime<Utc>>,
    ) -> Result<Value, String> {
        let now = Utc::now();
        self.mutate(engine, |mut x| {
            x["state"] = json!("exhausted");
            x["cooldownUntil"] = Value::Null;
            x["retryAt"] = json!((reset
                .map(|r| r + ChronoDuration::minutes(1))
                .unwrap_or(now + ChronoDuration::minutes(30)))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            x["lastFailure"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            x
        })
    }
}
struct EngineLock {
    path: PathBuf,
    token: String,
}
impl Drop for EngineLock {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path).ok().as_deref() == Some(self.token.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_claude_is_not_reactivated() {
        let state = json!({"schemaVersion":2,"engines":{"claude":{"state":"available","enabled":true},"worker":{"state":"available"}}});
        let normalized = normalized(state);
        assert_eq!(normalized["schemaVersion"], 3);
        assert_eq!(normalized["engines"]["claude"]["state"], "disabled");
        assert_eq!(normalized["engines"]["claude"]["enabled"], false);
        assert_eq!(normalized["engines"]["worker"]["enabled"], Value::Null);
        assert!(!available_at(
            &engine_snapshot(&normalized, "claude"),
            "claude",
            &Utc::now()
        ));
    }
    #[test]
    fn explicit_disable_wins() {
        let now = Utc::now();
        assert!(!available_at(
            &json!({"state":"available","enabled":false}),
            "worker",
            &now
        ));
        assert!(!available_at(&json!({"state":"exhausted"}), "worker", &now));
        assert!(available_at(&json!({"state":"available"}), "worker", &now));
    }
    #[test]
    fn updates_reload_durable_state() {
        let dir = std::env::temp_dir().join(format!(
            "orchestra-engine-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        let engine = EngineState::new(&dir);
        engine.mark_success("worker").unwrap();
        engine.mark_transient("worker").unwrap();
        engine.mark_transient("worker").unwrap();
        assert_eq!(
            engine.load()["engines"]["worker"]["consecutiveTransientFailures"],
            2
        );
        engine.mark_auth_failure("worker").unwrap();
        assert_eq!(engine.load()["engines"]["worker"]["state"], "disabled");
        let _ = fs::remove_dir_all(&dir);
    }
}
