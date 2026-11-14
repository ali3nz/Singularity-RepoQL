//! Option 2 upgrade dependency decisions only. The trusted Python caller
//! validates receipt ownership, path safety and native scheduler evidence.
//! This module never touches the filesystem or authorizes a replacement.
use serde_json::{json, Value};

const RECEIPTS: [&str; 6] = [
    "claude", "parent", "kanzo", "current", "previous", "retired",
];

fn valid_task_state(value: &str) -> bool {
    matches!(value, "UNKNOWN" | "REGISTERED" | "ABSENT")
}

pub fn evaluate(input: &Value) -> Result<Value, &'static str> {
    let row = input.as_object().ok_or("UPGRADE_INPUT_NOT_OBJECT")?;
    if row.len() != 3
        || !row.contains_key("receipts")
        || !row.contains_key("taskState")
        || !row.contains_key("dashboardTaskState")
    {
        return Err("UPGRADE_INPUT_SCHEMA_INVALID");
    }
    let task = input["taskState"]
        .as_str()
        .ok_or("UPGRADE_TASK_STATE_INVALID")?;
    let dashboard = input["dashboardTaskState"]
        .as_str()
        .ok_or("UPGRADE_DASHBOARD_TASK_STATE_INVALID")?;
    if !valid_task_state(task) {
        return Err("UPGRADE_TASK_STATE_INVALID");
    }
    if !valid_task_state(dashboard) {
        return Err("UPGRADE_DASHBOARD_TASK_STATE_INVALID");
    }
    let statuses = input["receipts"]
        .as_object()
        .ok_or("UPGRADE_RECEIPTS_INVALID")?;
    if statuses.len() != RECEIPTS.len()
        || RECEIPTS
            .iter()
            .any(|key| !statuses.get(*key).is_some_and(Value::is_boolean))
    {
        return Err("UPGRADE_RECEIPTS_INVALID");
    }
    let present =
        |name: &str| -> bool { statuses.get(name).and_then(Value::as_bool) == Some(true) };
    let mut actions = Vec::<&str>::new();
    match dashboard {
        "REGISTERED" => actions.push("REMOVE_OWNED_DASHBOARD_AFTER_VERIFYING_TASK_OWNER"),
        "UNKNOWN" => actions.push("VERIFY_DASHBOARD_TASK_OWNERSHIP"),
        _ => {}
    }
    match task {
        "REGISTERED" => actions.push("REMOVE_OWNED_SUPERVISOR_AFTER_VERIFYING_TASK_OWNER"),
        "UNKNOWN" => actions.push("VERIFY_NATIVE_SCHEDULER_TASK_OWNERSHIP"),
        _ => {}
    }
    if present("parent") {
        actions.push("ROLLBACK_RECEIPT_OWNED_PARENT_PROXY");
    }
    if present("claude") || present("kanzo") {
        actions.push("ROLLBACK_RECEIPT_OWNED_CLAUDE_AND_KANZO");
    }
    if present("current") {
        if present("previous") {
            actions.push("REVIEW_UPGRADE_SNAPSHOT_BEFORE_STAGE_REPLACEMENT");
        } else if present("retired") {
            actions.push("RESOLVE_RETIRED_SNAPSHOT_COLLISION");
        }
        actions.push("VERIFY_AND_STAGE_APPROVED_REPLACEMENT");
    } else {
        actions.push("PREPARE_FIRST_STAGE_AFTER_BUNDLE_VERIFICATION");
    }
    let clear = task == "ABSENT"
        && dashboard == "ABSENT"
        && !present("parent")
        && !present("claude")
        && !present("kanzo");
    let first = clear && !present("current") && !present("retired");
    let replace = clear && present("current") && !present("previous") && !present("retired");
    Ok(json!({
        "schema": "singularity-option2-upgrade-dependency-plan/v1",
        "option": 2,
        "receipt_presence": statuses,
        "supervisor_task_state_from_scheduler": task,
        "dashboard_task_state_from_scheduler": dashboard,
        "dependencies_cleared_for_stage_replacement": clear,
        "first_stage_clear": first,
        "existing_owned_stage_can_be_replaced": replace,
        "ordered_operator_actions": actions,
        "performed_changes": false,
        "windows_runtime_verified": false,
        "release_ready": false
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"receipts":{"claude":false,"parent":false,"kanzo":false,
            "current":false,"previous":false,"retired":false},
            "taskState":"ABSENT","dashboardTaskState":"ABSENT"})
    }
    #[test]
    fn empty_is_only_plan_for_first_stage() {
        let report = evaluate(&input()).unwrap();
        assert_eq!(report["first_stage_clear"], true);
        assert_eq!(report["release_ready"], false);
        assert_eq!(report["windows_runtime_verified"], false);
    }
    #[test]
    fn current_owned_stage_without_snapshot_may_be_replaced_after_evidence() {
        let mut item = input();
        item["receipts"]["current"] = json!(true);
        let report = evaluate(&item).unwrap();
        assert_eq!(report["existing_owned_stage_can_be_replaced"], true);
        item["receipts"]["previous"] = json!(true);
        let report = evaluate(&item).unwrap();
        assert_eq!(report["existing_owned_stage_can_be_replaced"], false);
        assert_eq!(
            report["ordered_operator_actions"][0],
            "REVIEW_UPGRADE_SNAPSHOT_BEFORE_STAGE_REPLACEMENT"
        );
    }
    #[test]
    fn task_unknown_blocks_and_places_actions_in_same_order() {
        let mut item = input();
        item["taskState"] = json!("UNKNOWN");
        item["dashboardTaskState"] = json!("REGISTERED");
        let result = evaluate(&item).unwrap();
        assert_eq!(
            result["ordered_operator_actions"][0],
            "REMOVE_OWNED_DASHBOARD_AFTER_VERIFYING_TASK_OWNER"
        );
        assert_eq!(
            result["ordered_operator_actions"][1],
            "VERIFY_NATIVE_SCHEDULER_TASK_OWNERSHIP"
        );
        assert_eq!(result["dependencies_cleared_for_stage_replacement"], false);
    }
    #[test]
    fn rejects_untrusted_inputs() {
        let mut item = input();
        item["receipts"]["claude"] = json!("false");
        assert!(evaluate(&item).is_err());
        let mut item = input();
        item["receipts"]["extra"] = json!(false);
        assert!(evaluate(&item).is_err());
        let mut item = input();
        item["taskState"] = json!("done");
        assert!(evaluate(&item).is_err());
    }
}
