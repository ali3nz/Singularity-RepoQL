//! Deterministic, read-only portions of memory/portable/task-recovery.mjs.
//! No generic CLI for recovery: real Kanzo authorization must happen in the
//! existing trusted Windows agent path before passing snapshots to this library.
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedUnit {
    pub unit_id: String,
    pub session_id: String,
    pub first_seq: i64,
    pub last_seq: i64,
    pub captured_at: Option<String>,
}

fn value_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

fn valid_task(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:task-[a-z0-9]{6,40}|kanzo:[1-9][0-9]{0,10})$").expect("valid task pattern")
    })
    .is_match(id)
}

fn valid_unit(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^oc:[A-Za-z0-9_-]+:[0-9]+-[0-9]+$").expect("valid unit pattern"))
        .is_match(id)
}

fn integral_number(value: &Value) -> Option<i64> {
    if let Some(i) = value.as_i64() {
        return Some(i);
    }
    let f = value.as_f64()?;
    if f.fract() != 0.0 || f < i64::MIN as f64 || f > i64::MAX as f64 {
        return None;
    }
    Some(f as i64)
}

pub fn linked_capture_units(ledger: &Value, task_id: &str, agent: &str) -> Vec<LinkedUnit> {
    if !valid_task(task_id) || agent.trim().is_empty() {
        return Vec::new();
    }
    let Some(units) = ledger.get("units").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (id, unit) in units {
        if !valid_unit(id)
            || unit.get("status").and_then(Value::as_str) != Some("reconciled")
            || unit.get("task_id_source").and_then(Value::as_str) != Some("binding")
            || unit.get("task_id").and_then(Value::as_str) != Some(task_id)
            || unit.get("agent").and_then(Value::as_str) != Some(agent)
        {
            continue;
        }
        let Some(session) = unit
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let (Some(first), Some(last)) = (
            unit.get("first_seq").and_then(integral_number),
            unit.get("last_seq").and_then(integral_number),
        ) else {
            continue;
        };
        if first > last {
            continue;
        }
        found.push(LinkedUnit {
            unit_id: id.clone(),
            session_id: session.to_owned(),
            first_seq: first,
            last_seq: last,
            captured_at: unit.get("at").filter(|v| !v.is_null()).map(value_string),
        });
    }
    found.sort_by(|a, b| {
        a.captured_at
            .as_deref()
            .unwrap_or("")
            .cmp(b.captured_at.as_deref().unwrap_or(""))
            .then_with(|| a.session_id.cmp(&b.session_id))
            .then_with(|| a.first_seq.cmp(&b.first_seq))
    });
    found
}

fn valid_identity(identity: &Value) -> bool {
    ["team_id", "user_id", "agent_id"].iter().all(|key| {
        identity
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn raw_rows<'a>(response: &'a Value, layer: &str) -> Option<&'a [Value]> {
    let Some(data) = response.get("data") else {
        return Some(&[]);
    };
    let fields: &[&str] = if layer == "L1" {
        &["atoms", "items", "memories"]
    } else {
        &["messages", "items"]
    };
    for key in fields {
        if let Some(value) = data.get(*key).filter(|v| !v.is_null()) {
            return value.as_array().map(Vec::as_slice);
        }
    }
    Some(&[])
}

fn response_ok(response: &Value, layer: &str) -> bool {
    if !response.is_object() {
        return false;
    }
    if response.get("error").is_some_and(|v| truthy(Some(v))) {
        return false;
    }
    if let Some(code) = response.get("code") {
        if code != &json!(0) {
            return false;
        }
    }
    raw_rows(response, layer).is_some()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        _ => true,
    }
}

fn bounded_limit(limit: i64) -> usize {
    limit.clamp(1, 10) as usize
}

fn compact_text(value: Option<&Value>) -> String {
    value
        .map(value_string)
        .unwrap_or_default()
        .chars()
        .take(360)
        .collect()
}

/// Pure post-authorization processing. The caller MUST verify Kanzo ownership,
/// use registered MemoryCore identity, and obtain both responses using task-id
/// pushdown. These in-process inputs are not independently authenticated here.
/// On any failed MemoryCore layer the result contains zero refs, not partial refs.
// Keep the existing explicit authority, snapshot and paging arguments.
#[allow(clippy::too_many_arguments)]
pub fn recover_from_verified_snapshots(
    ledger: &Value,
    task_id: &str,
    agent: &str,
    identity: &Value,
    query: &str,
    authorization_verified: bool,
    l1_response: &Value,
    l0_response: &Value,
    max_units: usize,
    l1_limit: i64,
    l0_limit: i64,
) -> Value {
    let empty = |code: &str| json!({"ok":false,"code":code,"refs":[]});
    if !valid_task(task_id)
        || !valid_identity(identity)
        || agent.trim().is_empty()
        || query.trim().is_empty()
        || query.encode_utf16().count() > 300
    {
        return empty("INVALID_OR_UNAUTHORIZED_REQUEST");
    }
    if !authorization_verified {
        return empty("KANZO_AUTHORIZATION_NOT_VERIFIED");
    }
    let units = linked_capture_units(ledger, task_id, agent);
    if units.is_empty() {
        return empty("NO_TASK_LINKED_EVIDENCE");
    }
    if units.len() > max_units {
        return empty("TASK_UNIT_BUDGET_EXCEEDED");
    }
    if !response_ok(l1_response, "L1") || !response_ok(l0_response, "L0") {
        return empty("MEMORYCORE_RECALL_FAILED");
    }
    let known_sessions: HashSet<&str> = units.iter().map(|u| u.session_id.as_str()).collect();
    let mut refs: Vec<Value> = Vec::new();
    let mut omitted: Vec<Value> = Vec::new();
    for (layer, response, limit) in [("L1", l1_response, l1_limit), ("L0", l0_response, l0_limit)] {
        let mut seen = HashSet::new();
        for row in raw_rows(response, layer)
            .unwrap()
            .iter()
            .take(bounded_limit(limit))
        {
            let id = row.get("id").filter(|v| truthy(Some(v)));
            let correct_task = row.get("task_id").and_then(Value::as_str) == Some(task_id);
            let correct_session = row
                .get("session_id")
                .filter(|v| !v.is_null())
                .is_none_or(|v| v.as_str().is_some_and(|s| known_sessions.contains(s)));
            let correct_identity = ["team_id", "user_id", "agent_id"].iter().all(|key| {
                row.get(*key)
                    .filter(|v| !v.is_null())
                    .is_none_or(|v| v == &identity[*key])
            });
            if id.is_none() || !correct_task || !correct_session || !correct_identity {
                omitted.push(json!({"layer":layer,"reason":"task_or_identity_mismatch"}));
                continue;
            }
            let id = value_string(id.unwrap());
            if !seen.insert(id.clone()) {
                continue;
            }
            let state = if truthy(row.get("superseded_by")) {
                Some("superseded")
            } else if truthy(row.get("supersedes")) {
                Some("supersedes")
            } else {
                None
            };
            let mut r = json!({
                "layer":layer, "id":id, "taskId":task_id,
                "sessionId":row.get("session_id").unwrap_or(&Value::Null),
                "timestamp":row.get("timestamp").filter(|v| !v.is_null())
                    .or_else(||row.get("recorded_at").filter(|v| !v.is_null()))
                    .or_else(||row.get("created_at")).unwrap_or(&Value::Null),
                "text":compact_text(row.get("content").filter(|v| !v.is_null()).or_else(|| row.get("body"))),
            });
            if let Some(state) = state {
                r["state"] = json!(state);
            }
            refs.push(r);
        }
    }
    refs.sort_by(|a, b| {
        value_string(&a["timestamp"])
            .cmp(&value_string(&b["timestamp"]))
            .then_with(|| value_string(&a["id"]).cmp(&value_string(&b["id"])))
    });
    let ok = !refs.is_empty();
    json!({
        "ok":ok,
        "code":if ok { "TASK_EVIDENCE_RECOVERED" } else { "NO_TASK_LINKED_EVIDENCE" },
        "taskId":task_id,
        "units":units,
        "refs":refs,
        "omitted":omitted,
        "advisory":true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        json!({"units":{
            "oc:s1:1-2":{"task_id":"task-abcdef1234","task_id_source":"binding","agent":"agent-alpha", "session_id":"s1", "first_seq":1,"last_seq":2,"status":"reconciled", "at":"2026-11-12T00:00:00Z"},
            "oc:s2:1-2":{"task_id":"task-other1234","task_id_source":"binding","agent":"agent-alpha", "session_id":"s2", "first_seq":1,"last_seq":2,"status":"reconciled"},
            "fake":{"task_id":"task-abcdef1234","task_id_source":"binding","agent":"agent-alpha", "session_id":"s1", "first_seq":1,"last_seq":2,"status":"reconciled"}
        }})
    }
    #[test]
    fn only_exact_bound_units_are_accepted() {
        assert_eq!(
            linked_capture_units(&fixture(), "task-abcdef1234", "agent-alpha").len(),
            1
        );
        assert_eq!(
            linked_capture_units(&fixture(), "task-abcdef1234", "wrong-agent").len(),
            0
        );
    }
    #[test]
    fn task_identity_leaks_are_removed_and_rows_are_chronological() {
        let identity = json!({"team_id":"t1","user_id":"u1","agent_id":"a1"});
        let l1 = json!({"code":0,"data":{"atoms":[
            {"id":"a","task_id":"task-abcdef1234","session_id":"s1","content":"valid","timestamp":"2026-11-12T11:00:00Z"},
            {"id":"leak","task_id":"task-other1234"},
            {"id":"foreign","task_id":"task-abcdef1234","session_id":"s1","agent_id":"wrong"}
        ]}});
        let l0 = json!({"code":0,"data":{"messages":[
            {"id":"b","task_id":"task-abcdef1234","session_id":"s1","content":"support","timestamp":"2026-11-12T09:00:00Z"}
        ]}});
        let result = recover_from_verified_snapshots(
            &fixture(),
            "task-abcdef1234",
            "agent-alpha",
            &identity,
            "incident",
            true,
            &l1,
            &l0,
            30,
            5,
            3,
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["refs"][0]["id"], "b");
        assert_eq!(result["refs"][1]["id"], "a");
        assert_eq!(result["omitted"].as_array().unwrap().len(), 2);
        let failed = recover_from_verified_snapshots(
            &fixture(),
            "task-abcdef1234",
            "agent-alpha",
            &identity,
            "incident",
            true,
            &l1,
            &json!({"code":1}),
            30,
            5,
            3,
        );
        assert_eq!(failed["code"], "MEMORYCORE_RECALL_FAILED");
        assert_eq!(failed["refs"], json!([]));
    }
    #[test]
    fn authorization_is_external_and_explicit() {
        let out = recover_from_verified_snapshots(
            &fixture(),
            "task-abcdef1234",
            "agent-alpha",
            &json!({"team_id":"t","user_id":"u","agent_id":"a"}),
            "x",
            false,
            &Value::Null,
            &Value::Null,
            30,
            5,
            3,
        );
        assert_eq!(out["code"], "KANZO_AUTHORIZATION_NOT_VERIFIED");
    }
}
