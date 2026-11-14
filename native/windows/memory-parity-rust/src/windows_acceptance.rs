//! Read-only Windows acceptance decisions. This crate receives already collected
//! evidence; it does not query Kanzo, Tencent, RepoQL, or modify a profile.
use serde_json::{json, Value};
use std::collections::HashSet;

fn reject(code: &str) -> Value {
    json!({"ok":false,"code":code})
}

/// Equivalent to validateDelegatedMap() in
/// native/windows/claude_complete_memory_profiles.mjs.
/// The roles originate in the caller's installed agent roster; this command
/// does not claim that the role list itself is authoritative.
fn js_trim_character(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}'
        | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}

pub fn delegated_map(input: &Value) -> Value {
    let Some(map) = input.get("map").and_then(Value::as_object) else {
        return reject("IDENTITY_MAP_REQUIRED");
    };
    let Some(roles) = input.get("delegatedRoles").and_then(Value::as_array) else {
        return reject("DELEGATED_ROLES_REQUIRED");
    };
    let Some(main_count) = input.get("mainRolesExcluded").and_then(Value::as_u64) else {
        return reject("MAIN_ROLE_COUNT_REQUIRED");
    };
    if roles.is_empty() || roles.len() > 64 || roles.iter().any(|v| !v.is_string()) {
        return reject("DELEGATED_ROLES_INVALID");
    }
    let parent = input.get("parent").filter(|v| !v.is_null());
    if let Some(parent) = parent {
        let Some(obj) = parent.as_object() else {
            return reject("PARENT_IDENTITY_INVALID");
        };
        if ["team_id", "user_id", "agent_id"]
            .iter()
            .any(|key| !obj.get(*key).is_some_and(Value::is_string))
        {
            return reject("PARENT_IDENTITY_INVALID");
        }
    }
    let mut seen = HashSet::new();
    for name in roles {
        let name = name.as_str().expect("validated role string");
        let id = map.get(name);
        if let Some(value) = id {
            if truthy(value) {
                match value.as_object() {
                    Some(obj)
                        if obj.len() == 3
                            && ["team_id", "user_id", "agent_id"]
                                .iter()
                                .all(|key| obj.contains_key(*key)) => {}
                    _ => return reject("DELEGATED_IDENTITY_SHAPE_INVALID"),
                }
            }
        }
        let Some(obj) = id.and_then(Value::as_object) else {
            return reject("DELEGATED_IDENTITY_MISSING_OR_INVALID");
        };
        let mut fields = Vec::new();
        for key in ["team_id", "user_id", "agent_id"] {
            let Some(value) = obj.get(key).and_then(Value::as_str) else {
                return reject("DELEGATED_IDENTITY_MISSING_OR_INVALID");
            };
            if value.is_empty()
                || value.encode_utf16().count() > 128
                || value.trim_matches(js_trim_character) != value
            {
                return reject("DELEGATED_IDENTITY_MISSING_OR_INVALID");
            }
            fields.push(value);
        }
        if fields[0].eq_ignore_ascii_case("ghost-companion")
            || fields[2].eq_ignore_ascii_case("ghost")
        {
            return reject("RETIRED_MEMORY_SCOPE_FORBIDDEN");
        }
        if let Some(parent) = parent {
            if ["team_id", "user_id", "agent_id"]
                .iter()
                .enumerate()
                .all(|(i, k)| parent.get(*k).and_then(Value::as_str) == Some(fields[i]))
            {
                return reject("DELEGATED_IDENTITY_REUSES_PARENT");
            }
        }
        // JSON array is a collision-resistant, delimiter-safe identity key.
        let identity = json!(fields).to_string();
        if !seen.insert(identity) {
            return reject("DELEGATED_IDENTITY_COLLISION");
        }
    }
    json!({"ok":true,"value":{
        "delegatedRoles":roles.len(),"mainRolesExcluded":main_count,
        "identityMapValidated":true
    }})
}

/// The CLI only classifies independently collected readback issues. It cannot
/// repair Tencent or update the RepoQL index.
pub fn document_action(input: &Value) -> Value {
    let Some(issues) = input.get("issues").and_then(Value::as_array) else {
        return reject("RECONCILIATION_ISSUES_INVALID");
    };
    if issues.iter().any(|v| !v.is_string()) {
        return reject("RECONCILIATION_ISSUES_INVALID");
    }
    let values: Vec<&str> = issues.iter().filter_map(Value::as_str).collect();
    let action = if values.contains(&"SOURCE_CHANGED_DURING_READBACK") {
        "STABILIZE_SOURCE_THEN_REPEAT"
    } else if values.iter().any(|v| v.starts_with("TENCENT_")) {
        "INVESTIGATE_TENCENT_INGESTION_AND_READBACK"
    } else if values.iter().any(|v| v.starts_with("REPOQL_")) {
        "INVESTIGATE_REPOQL_INDEX_AND_READBACK"
    } else if !values.is_empty() {
        "REVIEW_READBACK_FAILURE"
    } else {
        "NONE"
    };
    json!({"ok":true,"action":action})
}

/// Construct a repository-relative RepoQL file URI without treating it as a
/// filesystem path. Each segment is encoded like JavaScript encodeURIComponent.
/// Source path validation and reparse checks remain the caller's duty.
pub fn repoql_doc_uri(input: &Value) -> Value {
    let Some(path) = input.get("relative").and_then(Value::as_str) else {
        return reject("REPOQL_RELATIVE_DOCUMENT_URI_INVALID");
    };
    if path.is_empty()
        || path.starts_with('/')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return reject("REPOQL_RELATIVE_DOCUMENT_URI_INVALID");
    }
    let mut uri = String::from("file:///");
    for (index, segment) in path.split('/').enumerate() {
        if index > 0 {
            uri.push('/');
        }
        for byte in segment.as_bytes() {
            let plain = byte.is_ascii_alphanumeric()
                || matches!(
                    *byte,
                    b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
                );
            if plain {
                uri.push(char::from(*byte));
            } else {
                use std::fmt::Write;
                write!(&mut uri, "%{byte:02X}").expect("write into string");
            }
        }
    }
    json!({"ok":true,"uri":uri})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delegated_valid_and_isolated() {
        let input = json!({"map":{"board":{"team_id":"team","user_id":"user","agent_id":"board"}},
          "delegatedRoles":["board"],"mainRolesExcluded":4,"parent":null});
        assert_eq!(delegated_map(&input)["value"]["delegatedRoles"], 1);
        let mut collision = input.clone();
        collision["delegatedRoles"] = json!(["board", "board"]);
        assert_eq!(
            delegated_map(&collision)["code"],
            "DELEGATED_IDENTITY_COLLISION"
        );
    }
    #[test]
    fn repoql_uri_preserves_segments_and_encodes_unicode() {
        assert_eq!(
            repoql_doc_uri(&json!({"relative":"docs/a b/é.md"}))["uri"],
            "file:///docs/a%20b/%C3%A9.md"
        );
        assert_eq!(
            repoql_doc_uri(&json!({"relative":"../secret.md"}))["code"],
            "REPOQL_RELATIVE_DOCUMENT_URI_INVALID"
        );
    }
    #[test]
    fn document_actions_preserve_priority() {
        assert_eq!(
            document_action(&json!({"issues":["TENCENT_X","SOURCE_CHANGED_DURING_READBACK"]}))
                ["action"],
            "STABILIZE_SOURCE_THEN_REPEAT"
        );
        assert_eq!(document_action(&json!({"issues":[]}))["action"], "NONE");
    }
}
