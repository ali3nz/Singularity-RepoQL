//! Explicit native state CLI. The external runtime must supply its own
//! authorized state directory. This is not a production orchestration API.
use crate::{case_store, engine_state, resource_lease};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// A marker is only an explicit operator declaration, NOT proof the JS writer
/// has stopped. All old writers must be stopped and independently verified
/// before supplying this marker to a native state directory.
pub const STATE_EXCLUSIVE_MARKER: &str = ".orchestra-native-state-writer";
const STATE_EXCLUSIVE_VALUE: &str = "RUST_EXCLUSIVE_CASE_AND_ENGINE_STATE_V1\n";

fn require_native_state_writer(root: &Path) -> Result<(), String> {
    match fs::read(root.join(STATE_EXCLUSIVE_MARKER)) {
        Ok(bytes) if bytes == STATE_EXCLUSIVE_VALUE.as_bytes() => Ok(()),
        _ => Err("STATE_WRITER_NOT_EXCLUSIVE: operator-issued Rust state marker required".into()),
    }
}

fn mutates_state(action: &str) -> bool {
    matches!(action, "case_write" | "journal_intent" | "journal_complete")
        || (action.starts_with("engine_") && action != "engine_get")
}

/// For native CLI writes only, never silently replace unreadable JSON or
/// malformed journals. This is deliberate fail-closed hardening relative to
/// the legacy JS fallback, not a claimed source-parity behavior.
fn validate_existing_state(path: &Path, journal: bool) -> Result<(), String> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("STATE_PRECHECK_UNAVAILABLE: {e}")),
    };
    if journal {
        for (index, line) in data.split(|byte| *byte == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            if !matches!(serde_json::from_slice::<Value>(line), Ok(Value::Object(_))) {
                return Err(format!("CORRUPT_JOURNAL_STATE: line {}", index + 1));
            }
        }
    } else if !matches!(serde_json::from_slice::<Value>(&data), Ok(Value::Object(_))) {
        return Err("CORRUPT_JSON_STATE: refusing destructive replacement".into());
    }
    Ok(())
}

fn valid_id(input: &str) -> bool {
    !input.is_empty()
        && input.len() <= 128
        && input
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn execute(root: &Path, req: &Value) -> Result<Value, String> {
    let action = req
        .get("action")
        .and_then(Value::as_str)
        .ok_or("missing action")?;
    if mutates_state(action) {
        require_native_state_writer(root)?;
    }
    if action.starts_with("resource_") {
        resource_lease::require_exclusive(root)?;
        let path = root.join("resource-leases.json");
        return resource_lease::execute(&path, req);
    }
    // Engine state is rooted in the configured runs directory, not a
    // caller-provided arbitrary path.
    if action.starts_with("engine_") {
        let engine = req
            .get("engine")
            .and_then(Value::as_str)
            .ok_or("missing engine")?;
        if !valid_id(engine) {
            return Err("invalid engine identifier".into());
        }
        // Even availability queries can mutate persisted state when a cooldown expires.
        if action != "engine_get" {
            validate_existing_state(&root.join("engine-state.json"), false)?;
        }
        let state = engine_state::EngineState::new(root);
        return match action {
            "engine_get" => Ok(engine_state::engine_snapshot(&state.load(), engine)),
            "engine_available" => Ok(json!({"available":state.available(engine)?})),
            "engine_mark_success" => state.mark_success(engine),
            "engine_mark_auth_failure" => state.mark_auth_failure(engine),
            "engine_mark_provider_down" => state.mark_provider_down(engine),
            "engine_mark_transient" => state.mark_transient(engine),
            "engine_mark_privacy_skip" => state.mark_privacy_skip(engine),
            "engine_mark_quota" => state.mark_quota_exhausted(engine, None),
            _ => Err("unsupported engine action".into()),
        };
    }
    let case_id = req
        .get("caseId")
        .and_then(Value::as_str)
        .ok_or("missing caseId")?;
    if !valid_id(case_id) {
        return Err("invalid caseId".into());
    }
    let dir: PathBuf = root.join(case_id);
    if action == "case_write" {
        validate_existing_state(&dir.join("case.json"), false)?;
    }
    if matches!(action, "journal_intent" | "journal_complete") {
        validate_existing_state(&dir.join("ops.jsonl"), true)?;
    }
    match action {
        "case_read" => Ok(std::fs::read(dir.join("case.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(Value::Null)),
        "case_write" => case_store::write_case(
            &dir,
            req.get("expectedRev").and_then(Value::as_u64),
            req.get("next").cloned().unwrap_or(Value::Null),
        ),
        "journal_intent" => {
            case_store::journal_intent(&dir, req.get("intent").ok_or("missing intent")?)
        }
        "journal_complete" => {
            let op = req
                .get("opId")
                .and_then(Value::as_str)
                .ok_or("missing opId")?;
            let completion = req.get("completion").ok_or("missing completion")?;
            Ok(json!({"completed":case_store::journal_complete(&dir,op,completion)?}))
        }
        "journal_pending" => Ok(json!({"pending":case_store::pending_intents(&dir)})),
        "journal_read" => Ok(json!({"records":case_store::read_journal(&dir)})),
        _ => Err("unsupported state action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disallow_case_path_traversal() {
        let base = std::env::temp_dir();
        assert!(execute(&base, &json!({"action":"case_read","caseId":"../other"})).is_err());
        assert!(execute(&base, &json!({"action":"case_read","caseId":""})).is_err());
    }
    #[test]
    fn all_native_mutations_require_explicit_exclusive_state_writer() {
        let root = std::env::temp_dir().join(format!(
            "orch-state-gate-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        ));
        fs::create_dir_all(&root).unwrap();
        for req in [
            json!({"action":"case_write","caseId":"caseA","expectedRev":0,"next":{"phase":"A"}}),
            json!({"action":"journal_intent","caseId":"caseA","intent":{"opId":"x","op":"send"}}),
            json!({"action":"journal_complete","caseId":"caseA","opId":"x","completion":{"state":"unknown"}}),
            json!({"action":"engine_mark_success","engine":"worker"}),
            json!({"action":"engine_available","engine":"worker"}),
        ] {
            let err = execute(&root, &req).unwrap_err();
            assert!(err.starts_with("STATE_WRITER_NOT_EXCLUSIVE"), "{err}");
        }
        assert!(!root.join("caseA").exists());
        assert!(!root.join("engine-state.json").exists());
        assert!(
            execute(&root, &json!({"action":"case_read","caseId":"caseA"}))
                .unwrap()
                .is_null()
        );
        assert!(execute(&root, &json!({"action":"engine_get","engine":"worker"})).is_ok());
        fs::write(root.join(STATE_EXCLUSIVE_MARKER), "wrong\n").unwrap();
        assert!(execute(
            &root,
            &json!({"action":"engine_mark_success","engine":"worker"})
        )
        .is_err());
        fs::write(root.join(STATE_EXCLUSIVE_MARKER), STATE_EXCLUSIVE_VALUE).unwrap();
        assert_eq!(execute(&root,&json!({"action":"case_write","caseId":"caseA","expectedRev":0,"next":{"phase":"A"}})).unwrap()["rev"], 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_mutations_refuse_corrupted_existing_state() {
        let root = std::env::temp_dir().join(format!(
            "orch-state-corruption-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        ));
        fs::create_dir_all(root.join("caseA")).unwrap();
        fs::write(root.join(STATE_EXCLUSIVE_MARKER), STATE_EXCLUSIVE_VALUE).unwrap();
        fs::write(root.join("caseA/case.json"), "{broken").unwrap();
        assert!(execute(
            &root,
            &json!({"action":"case_write","caseId":"caseA","expectedRev":0,"next":{}})
        )
        .unwrap_err()
        .starts_with("CORRUPT_JSON_STATE"));
        assert_eq!(
            fs::read_to_string(root.join("caseA/case.json")).unwrap(),
            "{broken"
        );
        fs::write(root.join("caseA/ops.jsonl"), "{broken\n").unwrap();
        assert!(execute(
            &root,
            &json!({"action":"journal_intent","caseId":"caseA",
            "intent":{"opId":"x","op":"send"}})
        )
        .unwrap_err()
        .starts_with("CORRUPT_JOURNAL_STATE"));
        assert_eq!(
            fs::read_to_string(root.join("caseA/ops.jsonl")).unwrap(),
            "{broken\n"
        );
        fs::write(root.join("engine-state.json"), "{broken").unwrap();
        assert!(execute(
            &root,
            &json!({"action":"engine_mark_success","engine":"worker"})
        )
        .unwrap_err()
        .starts_with("CORRUPT_JSON_STATE"));
        assert_eq!(
            fs::read_to_string(root.join("engine-state.json")).unwrap(),
            "{broken"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
