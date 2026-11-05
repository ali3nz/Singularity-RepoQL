//! Pure classification from kit/lib/deviation-ledger.mjs. Never modifies the ledger.
use serde_json::{json, Value};

const MATERIAL: [&str; 8] = [
    "scope-expansion",
    "new-persistent-state",
    "changed-migration-order",
    "changed-acceptance-criterion",
    "changed-worker-ownership",
    "changed-destructive-operation",
    "changed-gate-semantics",
    "changed-run-identity",
];

pub fn classify(kind: &Value, detail: &Value) -> Value {
    let k = js_text(Some(kind));
    if k == "minor-substitution" {
        return json!({"requiresRegate":false,"rationale":"minor substitution: equivalent behaviour/files/evidence"});
    }
    if MATERIAL.contains(&k.as_str()) {
        let extra = if truthy(detail) {
            format!(" — {}", js_text(Some(detail)))
        } else {
            String::new()
        };
        return json!({"requiresRegate":true,"rationale":format!("material deviation kind: {k}{extra}")});
    }
    json!({"requiresRegate":true,"rationale":format!("unknown deviation kind '{k}' treated as material (fail-closed)")})
}

pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub(crate) fn js_text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_text(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrecognized_deviation_requires_review() {
        let out = classify(&json!("unrecognized"), &json!("anything"));
        assert_eq!(out["requiresRegate"], true);
        assert!(out["rationale"].as_str().unwrap().contains("fail-closed"));
    }
    #[test]
    fn minor_substitution_does_not_regate() {
        assert_eq!(
            classify(&json!("minor-substitution"), &Value::Null)["requiresRegate"],
            false
        );
    }
}
