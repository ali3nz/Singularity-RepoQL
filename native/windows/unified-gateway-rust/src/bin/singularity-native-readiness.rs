//! Public, read-only Windows service readiness projection.
//!
//! Python retains control of all authenticated service probes. This binary
//! receives only seven result booleans and the enabled Office flag, without
//! credentials, exceptions, paths, URLs or service responses. A reachable
//! probe can never turn release_ready true.
use serde_json::{json, Value};
use std::io::{self, Read};

const LIMIT_BYTES: u64 = 65536;
const NOTE: &str = "Reachable verifies only a specific local probe. It does not prove installation, full authentication, capture, memory graph updates or real GUI acceptance.";
const PROBES: [&str; 7] = [
    "repoql_version",
    "tencent_session",
    "kanban_http",
    "agent_chat_state",
    "harness_rust_coordinator",
    "unified_graph_gateway",
    "claude_office_http",
];

fn status(enabled: bool, verified: bool, reason: &str) -> Value {
    if !enabled {
        json!({"state":"excluded", "verified":false})
    } else if verified {
        json!({"state":"reachable", "verified":true, "reason":null})
    } else {
        json!({"state":"unverified", "verified":false, "reason":reason})
    }
}

fn project(variant: Option<i64>, office: bool, probes: &Value) -> Value {
    let verified = |name: &str| probes.get(name).and_then(Value::as_bool) == Some(true);
    json!({
        "platform": "windows-native", "variant": variant,
        "repoql_required_version": "1.7.18", "release_ready": false,
        "note": NOTE,
        "services": {
            "repoql_version": status(true, verified("repoql_version"), "repoql_1_7_18_not_verified"),
            "tencent_session": status(true, verified("tencent_session"), "tencent_login_not_verified"),
            "kanban_http": status(true, verified("kanban_http"), "kanzo_ping_not_verified"),
            "agent_chat_state": status(true, verified("agent_chat_state"), "agent_chat_state_unavailable"),
            "harness_rust_coordinator": status(true, verified("harness_rust_coordinator"), "authenticated_rust_coordinator_unavailable"),
            "unified_graph_gateway": status(true, verified("unified_graph_gateway"), "unified_gateway_not_verified"),
            "claude_office_http": status(office, office && verified("claude_office_http"), "office_login_not_verified"),
            "native_gui_session": status(true, false, "real_windows_gui_acceptance_required"),
            "connector_indexing": status(true, false, "actual_connector_sweep_required"),
            "subscription_token_receipts": status(true, false, "authoritative_gui_receipts_required"),
            "claude_office_event_delivery": status(office, false, "live_gui_event_ack_required"),
            "installed_windows_service": status(true, false, "windows_service_lifecycle_required"),
        }
    })
}

fn process(request: &Value) -> Result<Value, &'static str> {
    let object = request.as_object().ok_or("INVALID_REQUEST")?;
    if object.len() != 3
        || !object.contains_key("variant")
        || !object.contains_key("office")
        || !object.contains_key("probes")
    {
        return Err("INVALID_REQUEST");
    }
    let variant = match object.get("variant") {
        Some(Value::Null) => None,
        Some(value) if value.as_i64() == Some(2) => Some(2),
        _ => return Err("INVALID_VARIANT"),
    };
    let office = object
        .get("office")
        .and_then(Value::as_bool)
        .ok_or("INVALID_OFFICE")?;
    let probes = object
        .get("probes")
        .and_then(Value::as_object)
        .ok_or("INVALID_PROBES")?;
    if probes.len() != PROBES.len()
        || PROBES
            .iter()
            .any(|key| probes.get(*key).and_then(Value::as_bool).is_none())
    {
        return Err("INVALID_PROBES");
    }
    Ok(project(variant, office, &Value::Object(probes.clone())))
}

fn main() {
    let mut input = Vec::new();
    let output = match io::stdin().take(LIMIT_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= LIMIT_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| process(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match output {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Readiness projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probes(verified: bool) -> Value {
        let mut items = serde_json::Map::new();
        for key in PROBES {
            items.insert(key.to_owned(), json!(verified));
        }
        Value::Object(items)
    }

    #[test]
    fn every_probe_green_never_grants_release() {
        let got = project(Some(2), true, &probes(true));
        assert_eq!(got["services"]["claude_office_http"]["state"], "reachable");
        assert_eq!(got["services"]["native_gui_session"]["state"], "unverified");
        assert_eq!(
            got["services"]["claude_office_event_delivery"]["state"],
            "unverified"
        );
        assert_eq!(got["release_ready"], false);
    }

    #[test]
    fn excluded_office_never_probed_or_marked_reachable() {
        let got = project(None, false, &probes(true));
        assert_eq!(
            got["services"]["claude_office_http"],
            json!({"state":"excluded", "verified":false})
        );
        assert_eq!(
            got["services"]["claude_office_event_delivery"]["state"],
            "excluded"
        );
        assert_eq!(got["services"]["repoql_version"]["state"], "reachable");
    }

    #[test]
    fn rejects_unknown_fields_and_untyped_probe_results() {
        let valid = json!({"variant":2, "office":true, "probes":probes(true)});
        assert!(process(&valid).is_ok());
        let mut unknown = valid.clone();
        unknown["token"] = json!("private");
        assert!(process(&unknown).is_err());
        let mut unsafe_probe = valid.clone();
        unsafe_probe["probes"]["repoql_version"] = json!("true");
        assert!(process(&unsafe_probe).is_err());
        let mut unknown_probe = valid.clone();
        unknown_probe["probes"]["secret"] = json!(true);
        assert!(process(&unknown_probe).is_err());
    }

    #[test]
    fn all_failed_service_probes_remain_unverified() {
        let got = project(Some(2), true, &probes(false));
        assert!(got["services"]
            .as_object()
            .unwrap()
            .values()
            .all(|value| value["verified"] == false));
        assert!(!got.to_string().contains("credentials"));
    }
}
