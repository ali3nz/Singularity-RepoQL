//! Pure run-health projection mirroring kit/lib/run-health.mjs.
//! File reading, time selection and fleet directory iteration remain with the
//! existing caller. This module has no authority to progress an orchestration.
use serde_json::{json, Value};

fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|x| !x.is_null())
        .or_else(|| b.filter(|x| !x.is_null()))
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
// JS uses optional `.length` as a truthiness test. Preserve strings and
// legacy objects with an explicit length, not just normal stagedRef arrays.
fn js_length_truthy(v: &Value) -> bool {
    match v {
        Value::Array(items) => !items.is_empty(),
        Value::String(s) => !s.is_empty(),
        Value::Object(obj) => obj.get("length").is_some_and(js_truthy),
        _ => false,
    }
}
fn eq_str(v: Option<&Value>, wanted: &str) -> bool {
    v.and_then(Value::as_str) == Some(wanted)
}
fn is_any(v: Option<&Value>, vals: &[&str]) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| vals.contains(&s))
}

/// Input requires a caller-provided ISO-8601 `generatedAt`. The production
/// JavaScript wrapper uses its own clock and passes one fixed timestamp to
/// the Rust side so comparison never depends on relative clock skew.
pub fn derive(req: &Value) -> Value {
    let state = req
        .get("state")
        .filter(|v| !v.is_null())
        .unwrap_or(&Value::Null);
    let lease = req
        .get("lease")
        .filter(|v| !v.is_null())
        .unwrap_or(&Value::Null);
    let retrieval = nullish(state.get("retrievalNotes"), state.get("retrieval"));
    let retrieval_status = if eq_str(retrieval, "failed") {
        "failed"
    } else if is_any(retrieval, &["degraded", "unreachable"]) {
        "degraded"
    } else {
        "healthy"
    };

    let worker_status = if eq_str(state.get("runState"), "COMPLETED") {
        "complete"
    } else {
        let lease_state = nullish(lease.get("state"), state.get("workerLeaseState"));
        if is_any(
            lease_state,
            &[
                "active",
                "waiting_external",
                "waiting_gate",
                "stalled",
                "expired",
            ],
        ) {
            lease_state.and_then(Value::as_str).unwrap_or("none")
        } else if state.get("runState").is_some_and(js_truthy) {
            "active"
        } else {
            "none"
        }
    };

    let gate = nullish(state.get("gateState"), state.get("gate"));
    let gate_status = if is_any(gate, &["accepted", "blocked", "not_required"]) {
        gate.and_then(Value::as_str).unwrap_or("not_required")
    } else if state.get("gatePending").is_some_and(js_truthy) {
        "pending"
    } else {
        "not_required"
    };

    let has_failed_criterion = state
        .get("criteriaResults")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|c| c.get("ok") == Some(&Value::Bool(false)))
        });
    let manifest_entries = req
        .get("evidenceManifest")
        .and_then(|v| v.get("entries"))
        .and_then(Value::as_array);
    let evidence = if has_failed_criterion {
        "failed"
    } else if let Some(entries) = manifest_entries.filter(|entries| !entries.is_empty()) {
        if entries
            .iter()
            .all(|e| e.get("sha256").is_some_and(js_truthy))
        {
            "complete"
        } else {
            "incomplete"
        }
    } else if state.get("evidenceComplete") == Some(&Value::Bool(true)) {
        "complete"
    } else {
        "incomplete"
    };

    let gh = nullish(req.get("ghStatus"), state.get("githubStatus"));
    let github = if is_any(gh, &["synced", "pending", "failed", "not_required"]) {
        gh.and_then(Value::as_str).unwrap_or("not_required")
    } else if state.get("githubIssue").is_some_and(js_truthy) {
        "synced"
    } else {
        "not_required"
    };

    let learning = state.get("learningStatus");
    let learning_status = if is_any(learning, &["captured", "pending", "not_required", "failed"]) {
        learning.and_then(Value::as_str).unwrap_or("not_required")
    } else if state.get("journalOutcomeAt").is_some_and(js_truthy)
        || state
            .get("memory")
            .and_then(|m| m.get("stagedRefs"))
            .is_some_and(js_length_truthy)
        || state
            .get("memory")
            .and_then(|m| m.get("staging"))
            .is_some_and(js_truthy)
    {
        "captured"
    } else {
        "not_required"
    };

    let run_id = nullish(req.get("runId"), state.get("runId"))
        .cloned()
        .unwrap_or(Value::Null);
    let generated_at = req.get("generatedAt").cloned().unwrap_or(Value::Null);
    json!({
        "schema": 1, "runId": run_id, "generatedAt": generated_at,
        "retrieval": retrieval_status, "worker": worker_status,
        "gate": gate_status, "evidence": evidence,
        "github": github, "learning": learning_status
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_health_and_witness_timestamp() {
        let result = derive(&json!({"generatedAt":"2026-11-12T00:00:00.000Z"}));
        assert_eq!(result["schema"], 1);
        assert_eq!(result["retrieval"], "healthy");
        assert_eq!(result["worker"], "none");
        assert_eq!(result["generatedAt"], "2026-11-12T00:00:00.000Z");
    }
    #[test]
    fn failed_criteria_override_hashed_manifest() {
        let result = derive(
            &json!({"generatedAt":"fixed", "state":{"criteriaResults":[{"ok":false}]},"evidenceManifest":{"entries":[{"sha256":"abc"}]}}),
        );
        assert_eq!(result["evidence"], "failed");
    }
    #[test]
    fn legacy_staged_refs_with_nonempty_length_are_counted() {
        let result =
            derive(&json!({"generatedAt":"fixed", "state":{"memory":{"stagedRefs":"legacy"}}}));
        assert_eq!(result["learning"], "captured");
    }
    #[test]
    fn foreign_worker_and_pending_gate_stay_separate() {
        let result = derive(
            &json!({"generatedAt":"fixed", "state":{"workerLeaseState":"stalled", "gatePending":true}}),
        );
        assert_eq!(result["worker"], "stalled");
        assert_eq!(result["gate"], "pending");
    }
}
