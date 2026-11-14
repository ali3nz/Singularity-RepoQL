//! Deterministic, read-only conversation reconciliation from memory-reconcile-core.mjs.
//! The MemoryCore HTTP transport, task scope and write/verify loop stay in their
//! existing owner. This pure selector never authorizes writes or queries a service.
use serde_json::{json, Value};
use std::collections::HashMap;

fn field<'a>(row: &'a Value, name: &str) -> &'a Value {
    row.get(name).unwrap_or(&Value::Null)
}

fn scalar(v: &Value) -> bool {
    matches!(
        v,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn identity(row: &Value) -> Result<String, &'static str> {
    if !row.is_object() {
        return Err("INVALID_MESSAGE_SHAPE");
    }
    let role = field(row, "role");
    let content = field(row, "content");
    let at = field(row, "recorded_at");
    let stamp = if at.is_null() {
        field(row, "timestamp")
    } else {
        at
    };
    // The JS identity is JSON.stringify([role, content, recorded_at ?? timestamp]).
    // Reject compound values: serde_json object key canonicalization could
    // otherwise merge two records which JavaScript considers distinct.
    if !scalar(role) || !scalar(content) || !scalar(stamp) {
        return Err("UNSUPPORTED_IDENTITY_SHAPE");
    }
    serde_json::to_string(&json!([role, content, stamp])).map_err(|_| "INVALID_MESSAGE_SHAPE")
}

pub fn missing_indices(input: &Value) -> Value {
    let (Some(rows), Some(messages)) = (
        input.get("rows").and_then(Value::as_array),
        input.get("messages").and_then(Value::as_array),
    ) else {
        return json!({"ok":false,"code":"INVALID_RECONCILIATION_INPUT"});
    };
    // Same bounded 100 x 100 query page ceiling as the production reconciler.
    if rows.len() > 10_000 || messages.len() > 10_000 {
        return json!({"ok":false,"code":"RECONCILIATION_LIMIT_EXCEEDED"});
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let key = match identity(row) {
            Ok(value) => value,
            Err(code) => return json!({"ok":false,"code":code}),
        };
        *counts.entry(key).or_default() += 1;
    }
    let mut missing = Vec::new();
    for (i, message) in messages.iter().enumerate() {
        let key = match identity(message) {
            Ok(value) => value,
            Err(code) => return json!({"ok":false,"code":code}),
        };
        let count = counts.entry(key).or_default();
        if *count == 0 {
            missing.push(i);
        } else {
            *count -= 1;
        }
    }
    json!({"ok":true,"missingIndexes":missing,"totalMessages":messages.len()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_multiplicity_and_timestamp_precedence() {
        let input = json!({
            "rows":[{"role":"user","content":"hello","timestamp":"t1"},
                    {"role":"user","content":"hello","recorded_at":"t1","timestamp":"different"}],
            "messages":[{"role":"user","content":"hello","timestamp":"t1"},
                        {"role":"user","content":"hello","timestamp":"t1"},
                        {"role":"user","content":"hello","timestamp":"t1"},
                        {"role":"assistant","content":"ok","timestamp":"t2"}]
        });
        assert_eq!(missing_indices(&input)["missingIndexes"], json!([2, 3]));
    }
    #[test]
    fn nullish_fallback_and_input_rejection() {
        let input = json!({"rows":[{"role":"user","content":"a","recorded_at":null,"timestamp":"t"}],
                          "messages":[{"role":"user","content":"a","timestamp":"t"}]});
        assert_eq!(missing_indices(&input)["missingIndexes"], json!([]));
        assert_eq!(
            missing_indices(&json!({}))["code"],
            "INVALID_RECONCILIATION_INPUT"
        );
        let compound = json!({"rows":[],"messages":[{"role":"user","content":{"x":1}}]});
        assert_eq!(
            missing_indices(&compound)["code"],
            "UNSUPPORTED_IDENTITY_SHAPE"
        );
    }
}
