//! Pure, read-only port of the `observeRun` decision in kit/lib/nanny.mjs.
//! Caller supplies observed state, worker statuses, freshness and liveness;
//! this module NEVER spawns workers, resumes runs, or changes durable state.
use serde_json::{json, Value};
fn strv<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn terminal(state: &str) -> bool {
    matches!(
        state,
        "COMPLETED" | "COMPLETED_UNREVIEWED" | "COMPLETED_OPERATOR_ACCEPTED" | "ABORTED"
    )
}
fn resumable(state: &str) -> bool {
    matches!(
        state,
        "RUNNING" | "PLANNED" | "REMEDIATION_EXHAUSTED" | "NEEDS_HUMAN_REVIEW"
    )
}
pub fn observe(i: &Value) -> Value {
    let run = i.get("runId").cloned().unwrap_or(Value::Null);
    let mut result = json!({"runId":run,"exists":false,"runState":null,"currentPhase":null,"completedThrough":0,"workers":[],"workerStatuses":{},"logAgeMinutes":null,"finalAcceptance":null,"findings":[],"actionable":null});
    if i.get("exists") != Some(&Value::Bool(true)) {
        return result;
    }
    result["exists"] = json!(true);
    if i.get("stateReadable") == Some(&Value::Bool(false)) {
        result["findings"] = json!(["state.json unreadable: simulated read failure"]);
        return result;
    }
    let state = i.get("state").unwrap_or(&Value::Null);
    result["runState"] = state.get("runState").cloned().unwrap_or(Value::Null);
    result["currentPhase"] = state.get("currentPhase").cloned().unwrap_or(Value::Null);
    result["completedThrough"] = state
        .get("completedThrough")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(0));
    result["workers"] = state
        .get("workers")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(["alpha"]));
    result["finalAcceptance"] = state.get("finalAcceptance").cloned().unwrap_or(Value::Null);
    let workers = result["workers"].as_array().cloned().unwrap_or_default();
    let worker_statuses = i.get("workerStatuses").unwrap_or(&Value::Null);
    for w in &workers {
        if let Some(key) = w.as_str() {
            result["workerStatuses"][key] = worker_statuses
                .get(key)
                .cloned()
                .unwrap_or(json!("missing"));
        }
    }
    result["logAgeMinutes"] = i.get("logAgeMinutes").cloned().unwrap_or(Value::Null);
    let Some(run_state) = strv(&result, "runState") else {
        return result;
    };
    let run_state = run_state.to_owned();
    if terminal(&run_state) {
        return result;
    }
    if i.get("halted") == Some(&Value::Bool(true)) {
        result["findings"]=json!(["run is HALTED (operator marker file present) — automatic paths refuse; removal is an explicit operator action"]);
        return result;
    }
    let coord = strv(i, "coordinatorState").unwrap_or("UNKNOWN").to_owned();
    result["coordinatorState"] = json!(coord);
    if run_state == "RUNNING" && coord != "RUNNING" {
        result["findings"] = json!([format!("coordinator {coord} while run is RUNNING")]);
        result["actionable"] = json!({"kind":"RESUME","why":"coordinator died mid-run; detached resume --go is the proven recovery"});
        return result;
    }
    let verdict = result["finalAcceptance"]
        .get("verdict")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if run_state == "NEEDS_HUMAN_REVIEW" && verdict.as_deref() == Some("NEEDS_HUMAN_REVIEW") {
        let stale = i.get("staleEvidence") == Some(&Value::Bool(true));
        result["staleEvidence"] = json!(stale);
        if stale {
            let signal = strv(i, "signalName")
                .filter(|s| !s.is_empty())
                .unwrap_or("latest gate signal");
            result["findings"]=json!([format!("held acceptance with staged evidence older than {signal} (remediation landed after the snapshot)")]);
            result["actionable"] = json!({"kind":"RE_DRIVE_HOLD","why":"acceptance re-judged pre-fix evidence; one fresh-evidence re-drive is bounded"});
        } else {
            result["findings"] =
                json!(["final acceptance HELD with current evidence — operator decision required"]);
            result["actionable"] =
                json!({"kind":"ESCALATE","why":"held acceptance is a genuine operator decision"});
        }
        return result;
    }
    if resumable(&run_state)
        && run_state != "RUNNING"
        && !(run_state == "NEEDS_HUMAN_REVIEW" && verdict.is_some())
        && coord != "RUNNING"
    {
        let age = result["logAgeMinutes"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or("?".into());
        result["findings"] = json!([format!(
            "run is {run_state} (age {age}min) with coordinator {coord}"
        )]);
        result["actionable"] = json!({"kind":"RESUME","why":format!("{run_state} run not engaged; bounded resume --go")});
        return result;
    }
    if run_state == "RUNNING" && result["logAgeMinutes"].as_i64().is_some_and(|x| x >= 20) {
        let age = result["logAgeMinutes"].as_i64().unwrap_or(0);
        result["findings"] = json!([format!(
            "run.log quiet {age}min while RUNNING (worker stall?)"
        )]);
        result["actionable"] = json!({"kind":"ESCALATE","why":"possible worker stall"});
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_halt_precedes_resume() {
        let x = json!({"runId":"R","exists":true,"state":{"runState":"RUNNING"},"halted":true,"coordinatorState":"DEAD"});
        assert!(observe(&x)["actionable"].is_null());
    }
    #[test]
    fn stale_running_escalates_not_spawns() {
        let x = json!({"runId":"R","exists":true,"state":{"runState":"RUNNING"},"coordinatorState":"RUNNING","logAgeMinutes":21});
        assert_eq!(observe(&x)["actionable"]["kind"], "ESCALATE");
    }
}
