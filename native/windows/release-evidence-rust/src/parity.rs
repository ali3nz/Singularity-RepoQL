//! Source-compatible port of native/windows/compare_production_parity.py.
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Map, Value};

pub const SCHEMA: &str = "singularity-runtime-parity/v1";
pub const COMMON: &[&str] = &[
    "clean_install",
    "upgrade_rollback",
    "service_restart",
    "gui_native_session",
    "automatic_capture",
    "new_session_recall",
    "agent_identity_isolation",
    "memory_extraction",
    "documentation_assessment",
    "documentation_update",
    "verified_doc_ingestion",
    "knowledge_candidate_evaluation",
    "gated_knowledge_promotion",
    "conflict_correction",
    "two_provider_failover",
    "repoql_cli_connector_compatibility",
    "repoql_mcp_query",
    "repoql_index_and_retrieve",
    "tencent_connector_abi1",
    "agent_chat_durable_delivery",
    "kanban_create_update_readback",
    "dashboard_embedded_login",
    "live_memory_graph_refresh",
    "windows_cpu_attribution",
    "gui_subscription_usage_source",
];
pub const OPTIONAL: &[&str] = &[
    "ghost_task_lifecycle",
    "ghost_prompt_edit_history",
    "ghost_dream_recovery",
    "office_native_presence_events",
    "office_dashboard_embed",
];

pub fn mandatory(variant: &Value) -> Option<Vec<&'static str>> {
    // serde_json::Value::as_i64 does NOT coerce booleans or strings to an option.
    let number = variant.as_i64()?;
    match number {
        1 | 3 => Some(COMMON.to_vec()),
        2 | 4 => Some(COMMON.iter().chain(OPTIONAL.iter()).copied().collect()),
        _ => None,
    }
}

fn string_eq(row: &Value, key: &str, expected: &str) -> bool {
    row.get(key).and_then(Value::as_str) == Some(expected)
}

fn observation(entry: Option<&Value>, now: DateTime<Utc>, max_age_days: i64) -> &'static str {
    let Some(row) = entry.and_then(Value::as_object) else {
        return "MISSING";
    };
    let v = Value::Object(row.clone());
    if !string_eq(&v, "result", "PASS") {
        return "NOT_PASSED";
    }
    let evidence = v.get("evidence_id").and_then(Value::as_str);
    if evidence.is_none_or(|s| s.trim().is_empty() || s.chars().count() > 512) {
        return "NO_EVIDENCE";
    }
    let parsed = v
        .get("observed_at")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.with_timezone(&Utc));
    let Some(timestamp) = parsed else {
        return "STALE_OR_INVALID_TIMESTAMP";
    };
    if timestamp > now + Duration::minutes(5)
        || now.signed_duration_since(timestamp) > Duration::days(max_age_days)
    {
        return "STALE_OR_INVALID_TIMESTAMP";
    }
    if v.get("synthetic").and_then(Value::as_bool) == Some(true) {
        return "SYNTHETIC_NOT_ACCEPTED";
    }
    "PASS_RECEIPTED"
}

pub fn compare(
    production: &Value,
    windows: &Value,
    now: DateTime<Utc>,
    max_age_days: i64,
) -> Value {
    let mut problems = Vec::<&str>::new();
    if !string_eq(production, "schema", SCHEMA) || !string_eq(windows, "schema", SCHEMA) {
        problems.push("receipt_schema_missing_or_wrong");
    }
    if !string_eq(production, "runtime", "production-linux-docker") {
        problems.push("production_runtime_not_proven");
    }
    if !string_eq(windows, "runtime", "native-windows-no-wsl") {
        problems.push("native_windows_runtime_not_proven");
    }
    let variant = windows.get("variant").cloned().unwrap_or(Value::Null);
    let required = match mandatory(&variant) {
        Some(rows) => rows,
        None => {
            problems.push("invalid_windows_option");
            Vec::new()
        }
    };
    if !string_eq(production, "product", "Singularity RepoQL")
        || !string_eq(windows, "product", "Singularity RepoQL")
    {
        problems.push("wrong_product");
    }
    if !string_eq(windows, "repoql_version", "1.7.18") {
        problems.push("windows_repoql_1_7_18_not_proven");
    }
    if !["1.7.15", "1.7.18"].contains(
        &production
            .get("repoql_version")
            .and_then(Value::as_str)
            .unwrap_or(""),
    ) {
        problems.push("production_repoql_version_not_in_comparison_scope");
    }
    if production.get("connector_abi").and_then(Value::as_i64) != Some(1)
        || windows.get("connector_abi").and_then(Value::as_i64) != Some(1)
    {
        problems.push("connector_abi1_not_proven");
    }
    let mut checks = Map::new();
    let mut accepted = 0usize;
    for feature in &required {
        let p = production
            .get("checks")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get(*feature));
        let w = windows
            .get("checks")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get(*feature));
        let lhs = observation(p, now, max_age_days);
        let rhs = observation(w, now, max_age_days);
        if lhs == "PASS_RECEIPTED" && rhs == "PASS_RECEIPTED" {
            accepted += 1;
        }
        checks.insert((*feature).into(), json!({"production":lhs, "windows":rhs}));
    }
    let ready = problems.is_empty() && !required.is_empty() && accepted == required.len();
    // No evidence source strings, hosts, paths, or receipt bodies are echoed.
    json!({"schema":"singularity-parity-comparison/v1", "ready":ready,
        "scope":format!("option-{}", variant.as_i64().map(|v| v.to_string()).unwrap_or_else(|| {
            if variant.is_null() { "None".into() } else if variant == Value::Bool(true) { "True".into() }
            else if variant == Value::Bool(false) { "False".into() } else if let Some(s) = variant.as_str() { s.to_owned() }
            else { variant.to_string() }
        })),
        "problems":problems,"accepted_checks":accepted,"required_checks":required.len(),
        "checks":checks,
        "note":"Evidence IDs require independent review. This comparator cannot authenticate the actual production or Windows host."})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-29T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    fn receipt(runtime: &str, variant: i64) -> Value {
        let required = mandatory(&json!(variant)).unwrap();
        let mut checks = Map::new();
        for name in required {
            checks.insert(name.into(), json!({"result":"PASS","evidence_id":"receipt-001","observed_at":"2026-10-29T01:00:00Z"}));
        }
        json!({"schema":SCHEMA,"product":"Singularity RepoQL","runtime":runtime,
            "repoql_version":if runtime=="native-windows-no-wsl" { "1.7.18" } else { "1.7.15" },
            "connector_abi":1,"variant":variant,"checks":checks})
    }
    #[test]
    fn happy_path_and_missing_evidence() {
        let a = receipt("production-linux-docker", 1);
        let mut b = receipt("native-windows-no-wsl", 1);
        assert_eq!(compare(&a, &b, now(), 7)["ready"], true);
        b["checks"]
            .as_object_mut()
            .unwrap()
            .remove("new_session_recall");
        assert_eq!(
            compare(&a, &b, now(), 7)["checks"]["new_session_recall"]["windows"],
            "MISSING"
        );
        assert_eq!(compare(&a, &b, now(), 7)["ready"], false);
    }
    #[test]
    fn future_stale_synthetic_are_rejected() {
        let a = receipt("production-linux-docker", 2);
        let mut b = receipt("native-windows-no-wsl", 2);
        b["checks"]["ghost_dream_recovery"]["observed_at"] = json!("2026-10-15T01:00:00Z");
        assert_eq!(
            compare(&a, &b, now(), 7)["checks"]["ghost_dream_recovery"]["windows"],
            "STALE_OR_INVALID_TIMESTAMP"
        );
        b["checks"]["ghost_dream_recovery"]["observed_at"] = json!("2026-10-29T01:00:00Z");
        b["checks"]["ghost_dream_recovery"]["synthetic"] = json!(true);
        assert_eq!(compare(&a, &b, now(), 7)["ready"], false);
    }
    #[test]
    fn option_type_is_strict() {
        for input in [json!(true), json!("1"), json!(0), json!(5), Value::Null] {
            assert!(mandatory(&input).is_none());
        }
        assert_eq!(mandatory(&json!(2)).unwrap().len(), 30);
    }
}
