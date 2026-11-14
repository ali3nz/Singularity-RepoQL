//! Redacted acceptance evidence projection. Receipt/hash/path verification is
//! performed by the current Python evidence collector before this pure policy.
//! Even 24 reported PASS receipts never constitute independent release proof.
use serde_json::{json, Value};
use std::collections::BTreeSet;

const GATES: [&str; 24] = [
    "windows_rust_binaries",
    "windows_candidate_preparation",
    "native_claude_desktop_code_tab",
    "singularity_agents_9",
    "singularity_skills_10",
    "official_repoql_skills_17",
    "repoql_1_7_18_plugin_mcp",
    "kanzo_project_mcp",
    "kanzo_todo_doing_closed_lifecycle",
    "repoql_connectors_kanzo_memorycore_active",
    "native_dashboard_authenticated_http",
    "docker_dashboard_visual_parity",
    "windows_unified_graph_locality",
    "claude_memory_and_office_hooks",
    "claude_workflow_rule_refresh",
    "repoql_import_freshness_readback",
    "tencent_delegated_profiles_8",
    "tencent_parent_new_session_recall",
    "ghost_negative_scope_isolation",
    "tencent_repoql_doc_revision_parity",
    "claude_office_live_event_roundtrip",
    "windows_service_reboot_recovery",
    "windows_upgrade_rollback_uninstall",
    "native_no_wsl_docker_cli_dependency",
];

fn lowercase_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn hash_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn evaluate(input: &Value) -> Result<Value, &'static str> {
    let object = input.as_object().ok_or("ACCEPTANCE_INPUT_INVALID")?;
    if object.len() != 1 || !object.contains_key("gateResults") {
        return Err("ACCEPTANCE_INPUT_SCHEMA_INVALID");
    }
    let rows = input["gateResults"]
        .as_array()
        .ok_or("ACCEPTANCE_GATES_INVALID")?;
    if rows.len() != GATES.len() {
        return Err("ACCEPTANCE_GATE_COUNT_INVALID");
    }
    let mut missing = 0_usize;
    let mut passes = 0_usize;
    let mut fails = 0_usize;
    let mut commits = BTreeSet::<String>::new();
    for (i, row) in rows.iter().enumerate() {
        let obj = row.as_object().ok_or("ACCEPTANCE_GATE_ROW_INVALID")?;
        if obj.get("gate").and_then(Value::as_str) != Some(GATES[i]) {
            return Err("ACCEPTANCE_GATE_ORDER_INVALID");
        }
        match obj.get("status").and_then(Value::as_str) {
            Some("NOT_RUN") => {
                if obj.len() != 2 {
                    return Err("ACCEPTANCE_GATE_ROW_INVALID");
                }
                missing += 1;
            }
            Some("REPORTED_PASS_UNREVIEWED") | Some("REPORTED_FAIL") => {
                if obj.len() != 4 {
                    return Err("ACCEPTANCE_GATE_ROW_INVALID");
                }
                let commit = obj
                    .get("source_commit")
                    .and_then(Value::as_str)
                    .ok_or("ACCEPTANCE_GATE_ROW_INVALID")?;
                let digest = obj
                    .get("evidence_sha256")
                    .and_then(Value::as_str)
                    .ok_or("ACCEPTANCE_GATE_ROW_INVALID")?;
                if !lowercase_hex(commit, 40) || !hash_hex(digest) {
                    return Err("ACCEPTANCE_GATE_ROW_INVALID");
                }
                commits.insert(commit.to_ascii_lowercase());
                if obj.get("status").and_then(Value::as_str) == Some("REPORTED_PASS_UNREVIEWED") {
                    passes += 1;
                } else {
                    fails += 1;
                }
            }
            _ => return Err("ACCEPTANCE_GATE_STATUS_INVALID"),
        }
    }
    Ok(json!({
        "schema":"singularity-claude-complete-acceptance-evidence/v1",
        "scope":"Claude Code Complete native Windows",
        "required_gates":GATES.len(),
        "not_run":missing,
        "reported_pass_unreviewed":passes,
        "reported_fail":fails,
        "mixed_source_revisions":commits.len()>1,
        "all_live_tests_independently_verified":false,
        "release_ready":false,
        "gate_results":rows,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn blank() -> Value {
        json!({"gateResults":GATES.iter().map(|g|json!({"gate":g,"status":"NOT_RUN"})).collect::<Vec<_>>()})
    }
    #[test]
    fn absent_evidence_never_ready() {
        let result = evaluate(&blank()).unwrap();
        assert_eq!(result["not_run"], 24);
        assert_eq!(result["release_ready"], false);
    }
    #[test]
    fn all_receipts_passed_are_still_unverified() {
        let mut data = blank();
        for row in data["gateResults"].as_array_mut().unwrap() {
            row["status"] = json!("REPORTED_PASS_UNREVIEWED");
            row["source_commit"] = json!("a".repeat(40));
            row["evidence_sha256"] = json!("b".repeat(64));
        }
        let result = evaluate(&data).unwrap();
        assert_eq!(result["reported_pass_unreviewed"], 24);
        assert_eq!(result["all_live_tests_independently_verified"], false);
        assert_eq!(result["release_ready"], false);
        data["gateResults"][1]["source_commit"] = json!("c".repeat(40));
        assert_eq!(evaluate(&data).unwrap()["mixed_source_revisions"], true);
    }
    #[test]
    fn invalid_rows_cannot_claim_acceptance() {
        let mut data = blank();
        data["gateResults"][0]["status"] = json!("PASS");
        assert!(evaluate(&data).is_err());
        let mut data = blank();
        data["gateResults"][0]["unexpected"] = json!("credential");
        assert!(evaluate(&data).is_err());
    }
}
