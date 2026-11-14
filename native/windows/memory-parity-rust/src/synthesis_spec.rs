//! Mechanical, read-only validation of proposed synthesis records.
//! This does not create lineage, assign source authority or persist anything.
use serde_json::{json, Value};
use std::collections::HashSet;

const TYPES: [&str; 7] = [
    "current_preferences",
    "active_projects",
    "open_decisions",
    "known_conflicts",
    "operator_constraints",
    "recent_supersessions",
    "unfinished_work",
];
fn js_text(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            // JavaScript String(1.0) is "1", unlike serde_json Number::to_string().
            if let Some(f) = n.as_f64() {
                if f == 0.0 {
                    "0".to_string()
                } else if f.fract() == 0.0 && f.abs() < 1e21 {
                    format!("{f:.0}")
                } else {
                    n.to_string()
                }
            } else {
                n.to_string()
            }
        }
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_text(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

pub fn validate(input: &Value) -> Value {
    let spec = input.get("spec").unwrap_or(&Value::Null);
    let js_nullish = |key| {
        spec.get(key)
            .filter(|v| !v.is_null())
            .map(js_text)
            .unwrap_or_default()
    };
    let kind = js_nullish("type");
    let summary = js_nullish("summary").trim().to_string();
    let sources: Vec<String> = spec
        .get("sourceClaimIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_text).collect())
        .unwrap_or_default();
    let mut problems = Vec::new();
    if !TYPES.contains(&kind.as_str()) {
        problems.push(format!(
            "type not in enum: {kind} (plan §15 initial categories only)"
        ));
    }
    if summary.encode_utf16().count() < 8 {
        problems.push("summary: required (8+ chars)".to_string());
    }
    if sources.is_empty() {
        problems.push(
            "sourceClaimIds: synthesis requires at least one valid source claim (plan §14)"
                .to_string(),
        );
    }
    if sources.len() > 32 {
        problems.push("sourceClaimIds: exceeds 32".to_string());
    }
    if sources.iter().collect::<HashSet<_>>().len() != sources.len() {
        problems.push("sourceClaimIds: duplicates not allowed".to_string());
    }
    json!({"ok":true,"value":{"ok":problems.is_empty(),"problems":problems,
        "type":kind,"summary":summary,"sources":sources}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_real_lineage_and_valid_type() {
        let valid = json!({"spec":{"type":"open_decisions","summary":"Decision remains open", "sourceClaimIds":["x","y"]}});
        assert_eq!(validate(&valid)["value"]["ok"], true);
        assert_eq!(validate(&valid)["value"]["sources"], json!(["x", "y"]));
        let duplicate = json!({"spec":{"type":"open_decisions","summary":"Decision remains open","sourceClaimIds":["x","x"]}});
        assert_eq!(
            validate(&duplicate)["value"]["problems"],
            json!(["sourceClaimIds: duplicates not allowed"])
        );
        let absent = json!({"spec":{"type":"unknown","summary":"x"}});
        assert_eq!(validate(&absent)["value"]["ok"], false);
        assert_eq!(
            validate(&absent)["value"]["problems"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }
    #[test]
    fn duplicate_values_and_legacy_scalars() {
        let inp = json!({"spec":{"type":"active_projects","summary":"  éabcdefg  ","sourceClaimIds":[42,42]}});
        let out = validate(&inp);
        assert_eq!(out["value"]["summary"], "éabcdefg");
        assert_eq!(out["value"]["sources"], json!(["42", "42"]));
        assert_eq!(out["value"]["ok"], false);
        let null_item = json!({"spec":{"type":"active_projects","summary":"Valid enough", "sourceClaimIds":[null]}});
        assert_eq!(validate(&null_item)["value"]["sources"], json!(["null"]));
    }
}
