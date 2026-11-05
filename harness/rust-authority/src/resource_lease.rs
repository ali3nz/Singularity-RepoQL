//! Native resource mutation lease candidate, derived from `kit/lib/resource-lease.mjs`.
//!
//! Resource leases are separate from worker ownership and deployment intents.
//! Expired heartbeats alone never permit takeover when the owner is provably alive.
//! The original JS writer uses a different mutex implementation. Never run
//! native and legacy resource-lease writers against the same live state file.
use crate::case_store::atomic_write;
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const EXCLUSIVE_MARKER: &str = ".orchestra-native-resource-writer";
const EXCLUSIVE_MARKER_VALUE: &str = "RUST_EXCLUSIVE_RESOURCE_LEASES_V1\n";

pub fn require_exclusive(root: &Path) -> Result<(), String> {
    let bytes = fs::read(root.join(EXCLUSIVE_MARKER)).map_err(|_| {
        "RESOURCE_WRITER_NOT_EXCLUSIVE: missing operator-issued Rust writer marker".to_owned()
    })?;
    if bytes != EXCLUSIVE_MARKER_VALUE.as_bytes() {
        return Err("RESOURCE_WRITER_NOT_EXCLUSIVE: invalid marker contents".into());
    }
    Ok(())
}

const KNOWN: &[&str] = &[
    "openchamber/runtime",
    "openchamber/source",
    "orchestration/canonical-rules",
    "orchestration/config",
    "deploy/openchamber",
    "deploy/bridge",
    "secondbrain/vault-write",
];

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn pid_alive(pid: u64) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        fs::read(format!("/proc/{pid}/cmdline"))
            .map(|bytes| !bytes.is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    } // Cannot prove death; conservatively refuse takeover.
}

fn load(path: &Path) -> Result<Value, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"leases":{}})),
        Err(e) => return Err(format!("STATE_STORE_UNAVAILABLE: {e}")),
    };
    let mut state: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("STATE_STORE_UNAVAILABLE: {e}"))?;
    let map = state
        .as_object_mut()
        .ok_or("STATE_STORE_UNAVAILABLE: invalid store shape")?;
    if let Some(leases) = map.get("leases") {
        if !leases.is_object() {
            return Err("STATE_STORE_UNAVAILABLE: invalid lease map".into());
        }
    } else {
        map.insert("leases".to_owned(), json!({}));
    }
    Ok(state)
}

fn locked_update<T>(
    path: &Path,
    mut f: impl FnMut(&mut Value) -> Result<T, String>,
) -> Result<T, String> {
    let dir = path
        .parent()
        .ok_or("STATE_STORE_UNAVAILABLE: invalid state path")?;
    fs::create_dir_all(dir).map_err(|e| format!("STATE_STORE_UNAVAILABLE: {e}"))?;
    // Uses a kernel advisory lock rather than a stale-age breakable directory
    // lock. Ownership stays with the OS even for long-running mutations.
    let lock_path = path.with_extension("json.native.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("STATE_STORE_UNAVAILABLE: {e}"))?;
    lock.lock_exclusive()
        .map_err(|e| format!("STATE_STORE_UNAVAILABLE: {e}"))?;
    let mut state = load(path)?;
    let result = f(&mut state)?;
    let mut bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    atomic_write(path, &bytes).map_err(|e| format!("STATE_STORE_UNAVAILABLE: {e}"))?;
    drop(lock);
    Ok(result)
}

fn extra_allowed(id: &str, extras: &Value) -> bool {
    extras
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)))
}
fn valid_resource(id: &str, extras: &Value) -> bool {
    KNOWN.contains(&id) || extra_allowed(id, extras)
}
fn str_param<'a>(op: &'a Value, name: &str) -> Option<&'a str> {
    op.get(name)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}
fn lease_map_mut(state: &mut Value) -> Result<&mut Map<String, Value>, String> {
    state
        .get_mut("leases")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "STATE_STORE_UNAVAILABLE: invalid leases".to_string())
}
fn holder(lease: &Value, include_since: bool) -> Value {
    let mut val = json!({"caseId":lease.get("caseId"),"ownerPid":lease.get("ownerPid")});
    if include_since {
        val["since"] = lease.get("since").cloned().unwrap_or(Value::Null);
    }
    val
}

pub fn execute(state_path: &Path, op: &Value) -> Result<Value, String> {
    let action = str_param(op, "action").ok_or("missing action")?;
    let resource_id = if action == "resource_audit" {
        ""
    } else {
        str_param(op, "resourceId").ok_or("missing resourceId")?
    };
    let case_id = str_param(op, "caseId");
    let extras = op.get("extraResourceIds").unwrap_or(&Value::Null);
    let own_pid = u64::from(std::process::id());
    match action {
        "resource_acquire" => {
            if !valid_resource(resource_id, extras) {
                return Ok(
                    json!({"ok":false,"reason":"unknown-resource-id","resourceId":resource_id}),
                );
            }
            let Some(case_id) = case_id else {
                return Ok(json!({"ok":false,"reason":"missing-case-id","resourceId":resource_id}));
            };
            let heartbeat_ms = op
                .get("heartbeatMs")
                .and_then(Value::as_u64)
                .unwrap_or(60_000);
            locked_update(state_path, |state| {
                let leases = lease_map_mut(state)?;
                let current = leases.get(resource_id).cloned();
                if let Some(ref cur) = current {
                    let prev_case = cur.get("caseId").and_then(Value::as_str);
                    let prev_pid = cur.get("ownerPid").and_then(Value::as_u64).unwrap_or(0);
                    if prev_case == Some(case_id) && prev_pid != own_pid && pid_alive(prev_pid) {
                        return Ok(
                            json!({"ok":false,"reason":"held-by-same-case","holder":holder(cur,true)}),
                        );
                    }
                    if prev_case != Some(case_id) && pid_alive(prev_pid) {
                        let recent = now_ms().saturating_sub(
                            cur.get("heartbeatAt").and_then(Value::as_u64).unwrap_or(0),
                        ) < cur
                            .get("heartbeatMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(heartbeat_ms)
                            .saturating_mul(2);
                        let reason = if recent {
                            "held-by-other-case"
                        } else {
                            "owner-alive-heartbeat-stale"
                        };
                        return Ok(json!({"ok":false,"reason":reason,
                            "holder":holder(cur, recent)}));
                    }
                }
                let takeover = current.as_ref().and_then(|cur| {
                    let prev_pid = cur.get("ownerPid").and_then(Value::as_u64).unwrap_or(0);
                    let prev_case = cur.get("caseId").and_then(Value::as_str);
                    if prev_pid != own_pid || prev_case != Some(case_id) {
                        Some(json!({"prevCaseId":cur.get("caseId"),"prevOwnerPid":cur.get("ownerPid"),"at":timestamp()}))
                    } else { cur.get("takeoverOf").cloned() }
                });
                let since = current
                    .as_ref()
                    .filter(|cur| cur.get("caseId").and_then(Value::as_str) == Some(case_id))
                    .and_then(|cur| cur.get("since").cloned())
                    .unwrap_or_else(|| json!(timestamp()));
                let mut lease = json!({
                    "resourceId":resource_id,"caseId":case_id,
                    "threadId":op.get("threadId").cloned().unwrap_or(Value::Null),
                    "ownerPid":own_pid,"since":since,"heartbeatAt":now_ms(),"heartbeatMs":heartbeat_ms,
                });
                if let Some(takeover) = takeover {
                    lease["takeoverOf"] = takeover;
                }
                leases.insert(resource_id.to_owned(), lease.clone());
                Ok(json!({"ok":true,"lease":lease}))
            })
        }
        "resource_heartbeat" => locked_update(state_path, |state| {
            let leases = lease_map_mut(state)?;
            let Some(cur) = leases.get_mut(resource_id) else {
                return Ok(json!(false));
            };
            if cur.get("caseId").and_then(Value::as_str) == case_id
                && case_id.is_some()
                && cur.get("ownerPid").and_then(Value::as_u64) == Some(own_pid)
            {
                cur["heartbeatAt"] = json!(now_ms());
                Ok(json!(true))
            } else {
                Ok(json!(false))
            }
        }),
        "resource_confirm" => {
            let state = load(state_path)?;
            let cur = state["leases"].get(resource_id);
            match cur {
                None => Ok(json!({"ok":false,"reason":"absent","resourceId":resource_id})),
                Some(cur)
                    if case_id.is_some()
                        && cur.get("caseId").and_then(Value::as_str) != case_id =>
                {
                    Ok(
                        json!({"ok":false,"reason":"not-lease-owner","resourceId":resource_id,
                        "holder":{"caseId":cur.get("caseId")}}),
                    )
                }
                Some(cur) => Ok(json!({"ok":true,"lease":cur})),
            }
        }
        "resource_release" => locked_update(state_path, |state| {
            let leases = lease_map_mut(state)?;
            let Some(cur) = leases.get(resource_id) else {
                return Ok(json!({"ok":true,"note":"absent"}));
            };
            if case_id.is_some() && cur.get("caseId").and_then(Value::as_str) != case_id {
                return Ok(json!({"ok":false,"reason":"not-lease-owner"}));
            }
            if cur.get("ownerPid").and_then(Value::as_u64) != Some(own_pid) {
                return Ok(json!({"ok":false,"reason":"not-owner-pid"}));
            }
            leases.remove(resource_id);
            Ok(json!({"ok":true}))
        }),
        "resource_audit" => {
            let state = load(state_path)?;
            let leases = state
                .get("leases")
                .and_then(Value::as_object)
                .ok_or("STATE_STORE_UNAVAILABLE")?;
            let mut problems = Vec::new();
            for (id, lease) in leases {
                if !valid_resource(id, extras) {
                    problems.push(json!({"resourceId":id,"problem":"unknown-resource-id"}));
                }
                if lease
                    .get("caseId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
                {
                    problems.push(json!({"resourceId":id,"problem":"lease-without-case"}));
                }
            }
            Ok(json!({"ok":problems.is_empty(),"problems":problems,"leases":leases}))
        }
        _ => Err("unsupported resource action".into()),
    }
}

/// Used for same-process semantics. Seeded scenarios replace `$OWN_PID` with
/// the running process pid; the golden JS runner does the same independently.
pub fn script(root: &Path, request: &Value) -> Result<Value, String> {
    let operations = request
        .get("operations")
        .and_then(Value::as_array)
        .ok_or("missing operations")?;
    if operations.len() > 100 {
        return Err("too many resource operations".into());
    }
    require_exclusive(root)?;
    let path = root.join("resource-leases.json");
    if let Some(seed) = request.get("seed") {
        let mut seed = seed.clone();
        if let Some(leases) = seed.get_mut("leases").and_then(Value::as_object_mut) {
            for (_, lease) in leases {
                if lease.get("ownerPid") == Some(&json!("$OWN_PID")) {
                    lease["ownerPid"] = json!(std::process::id());
                }
            }
        }
        atomic_write(
            &path,
            serde_json::to_string(&seed)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;
    }
    let mut out = Vec::new();
    for op in operations {
        match execute(&path, op) {
            Ok(val) => out.push(normalize(op, &val)),
            Err(err) => out.push(json!({"error":err.starts_with("STATE_STORE_UNAVAILABLE")})),
        }
    }
    Ok(json!({"results":out}))
}

pub fn normalize(op: &Value, val: &Value) -> Value {
    if val.is_boolean() {
        return val.clone();
    }
    if op.get("action").and_then(Value::as_str) == Some("resource_audit") {
        let mut keys: Vec<&str> = val
            .get("leases")
            .and_then(Value::as_object)
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        keys.sort_unstable();
        let mut problems = val
            .get("problems")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        problems.sort_by_key(|v| format!("{}:{}", v["resourceId"], v["problem"]));
        return json!({"ok":val.get("ok"),"problems":problems,"leaseIds":keys});
    }
    let mut out = json!({});
    for key in ["ok", "reason", "note", "resourceId"] {
        if let Some(v) = val.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(lease) = val.get("lease") {
        out["lease"] = json!({"resourceId":lease.get("resourceId"),"caseId":lease.get("caseId"),
            "threadId":lease.get("threadId"),"heartbeatMs":lease.get("heartbeatMs"),
            "ownerIsSelf":lease.get("ownerPid").and_then(Value::as_u64)==Some(std::process::id() as u64),
            "takeover":lease.get("takeoverOf").is_some()});
    }
    if let Some(holder) = val.get("holder") {
        out["holder"] = json!({"caseId":holder.get("caseId"),
            "ownerIsSelf":holder.get("ownerPid").and_then(Value::as_u64)==Some(std::process::id() as u64)});
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> std::path::PathBuf {
        // Each test needs its own directory: two tests starting in the same
        // millisecond previously shared a path and raced on cleanup.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "resource-{}-{}-{}",
            std::process::id(),
            now_ms(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn live_foreign_owner_never_stolen_even_if_heartbeat_stale() {
        let root = temp();
        let path = root.join("resource-leases.json");
        let initial = json!({"leases":{"orchestration/config":{
            "resourceId":"orchestration/config","caseId":"other","ownerPid":std::process::id(),
            "heartbeatAt":0,"heartbeatMs":1}}});
        fs::create_dir_all(&root).unwrap();
        atomic_write(&path, initial.to_string().as_bytes()).unwrap();
        let result=execute(&path,&json!({"action":"resource_acquire","resourceId":"orchestration/config","caseId":"new"})).unwrap();
        assert_eq!(result["reason"], "owner-alive-heartbeat-stale");
        assert_eq!(
            load(&path).unwrap()["leases"]["orchestration/config"]["caseId"],
            "other"
        );
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn refuse_unknown_resource_and_unowned_release() {
        let root = temp();
        let path = root.join("resource-leases.json");
        let unknown = execute(
            &path,
            &json!({"action":"resource_acquire","resourceId":"anything","caseId":"C"}),
        )
        .unwrap();
        assert_eq!(unknown["reason"], "unknown-resource-id");
        let ok = execute(
            &path,
            &json!({"action":"resource_acquire","resourceId":"deploy/bridge","caseId":"C"}),
        )
        .unwrap();
        assert_eq!(ok["ok"], true);
        let no = execute(
            &path,
            &json!({"action":"resource_release","resourceId":"deploy/bridge","caseId":"other"}),
        )
        .unwrap();
        assert_eq!(no["reason"], "not-lease-owner");
        assert_eq!(
            execute(
                &path,
                &json!({"action":"resource_release","resourceId":"deploy/bridge","caseId":"C"})
            )
            .unwrap()["ok"],
            true
        );
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn exclusive_writer_gate_requires_exact_marker() {
        let root = temp();
        fs::create_dir_all(&root).unwrap();
        assert!(require_exclusive(&root).is_err());
        fs::write(root.join(EXCLUSIVE_MARKER), "wrong").unwrap();
        assert!(require_exclusive(&root).is_err());
        fs::write(root.join(EXCLUSIVE_MARKER), EXCLUSIVE_MARKER_VALUE).unwrap();
        assert!(require_exclusive(&root).is_ok());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn corrupt_lease_state_fails_closed() {
        let root = temp();
        let path = root.join("resource-leases.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, b"not-json").unwrap();
        let err = execute(
            &path,
            &json!({"action":"resource_acquire","resourceId":"deploy/bridge","caseId":"C"}),
        )
        .unwrap_err();
        assert!(err.starts_with("STATE_STORE_UNAVAILABLE"));
        let _ = fs::remove_dir_all(root);
    }
}
