//! Read-only Windows telemetry model-usage normalizer.
//!
//! This process never receives a prompt, transcript, token, credential, URL,
//! private path, run identity or network capability. The Python collector owns
//! the database and checks native output against its reference before writes.
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_REQUEST_BYTES: u64 = 128 * 1024;
const MAX_ROWS: usize = 128;

fn text<'a>(row: &'a Value, name: &str) -> &'a str {
    row.get(name).and_then(Value::as_str).unwrap_or("")
}

fn measured(row: &Value, name: &str) -> Value {
    match row.get(name) {
        Some(v) if v.is_number() => {
            let number = v.as_f64().unwrap_or(f64::NAN);
            if number.is_finite() && (0.0..1e15).contains(&number) {
                json!(number.trunc() as i64)
            } else {
                Value::Null
            }
        }
        _ => Value::Null,
    }
}

fn reported_cost(row: &Value, name: &str) -> Value {
    match row.get(name) {
        Some(v) if v.is_number() => {
            let cost = v.as_f64().unwrap_or(f64::NAN);
            if cost.is_finite() && (0.0..1e9).contains(&cost) {
                json!(cost)
            } else {
                Value::Null
            }
        }
        _ => Value::Null,
    }
}

fn provider(engine: &str, model: &str) -> Value {
    if let Some((head, _)) = model.split_once('/') {
        return json!(head.to_lowercase());
    }
    for (prefix, result) in [
        ("openai", "openai"),
        ("opencode", "opencode"),
        ("freebuff", "freebuff"),
        ("claude", "claude"),
    ] {
        if engine.starts_with(prefix) {
            return json!(result);
        }
    }
    if engine.is_empty() {
        Value::Null
    } else {
        json!(engine.to_lowercase())
    }
}

fn normalize(row: &Value) -> Value {
    let engine = text(row, "engine");
    let model = text(row, "model");
    let e = engine.to_lowercase();
    let m = model.to_lowercase();
    let sol =
        matches!(e.as_str(), "openai-sol" | "chatgpt" | "chatgpt-sol") || m.starts_with("chatgpt/");
    let scope = text(row, "usageScope");
    let measured_scope = matches!(scope, "outbound_request" | "transport" | "sender");
    let (input, output, cost) = if sol {
        if measured_scope {
            (
                measured(row, "sendInputTokens"),
                measured(row, "sendOutputTokens"),
                reported_cost(row, "sendCostUsd"),
            )
        } else {
            (Value::Null, Value::Null, Value::Null)
        }
    } else {
        // Preserve Python's existing token values for ordinary engines.
        (
            row.get("inputTokens").cloned().unwrap_or(Value::Null),
            row.get("outputTokens").cloned().unwrap_or(Value::Null),
            reported_cost(row, "costUsd"),
        )
    };
    let receiving = sol && input.is_null() && output.is_null() && cost.is_null();
    let cost_kind = if receiving {
        "review_receiving_side"
    } else if !cost.is_null() {
        "reported"
    } else {
        "unknown"
    };
    json!({
        "provider": provider(engine, model),
        "tokens_in": input,
        "tokens_out": output,
        "cost_usd": cost,
        "cost_kind": cost_kind,
    })
}

fn process(req: &Value) -> Value {
    if req.get("schema").and_then(Value::as_str) != Some("singularity-model-usage/v1") {
        return json!({"ok": false, "code": "SCHEMA_INVALID"});
    }
    let Some(rows) = req.get("rows").and_then(Value::as_array) else {
        return json!({"ok": false, "code": "ROWS_INVALID"});
    };
    if rows.len() > MAX_ROWS || rows.iter().any(|r| !r.is_object()) {
        return json!({"ok": false, "code": "ROWS_INVALID"});
    }
    // Whitelist every field. Do not accept prompts, run identifiers or paths.
    const ALLOWED: &[&str] = &[
        "engine",
        "model",
        "usageScope",
        "inputTokens",
        "outputTokens",
        "costUsd",
        "sendInputTokens",
        "sendOutputTokens",
        "sendCostUsd",
    ];
    for row in rows {
        let object = row.as_object().expect("rows validated");
        if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
            return json!({"ok": false, "code": "UNEXPECTED_FIELD"});
        }
        if ["engine", "model", "usageScope"].iter().any(|key| {
            row.get(*key)
                .is_some_and(|v| !v.is_string() || v.as_str().unwrap_or("").len() > 128)
        }) {
            return json!({"ok": false, "code": "TEXT_INVALID"});
        }
        if [
            "inputTokens",
            "outputTokens",
            "costUsd",
            "sendInputTokens",
            "sendOutputTokens",
            "sendCostUsd",
        ]
        .iter()
        .any(|key| {
            row.get(*key)
                .is_some_and(|v| !(v.is_number() || v.is_boolean() || v.is_null()))
        }) {
            return json!({"ok": false, "code": "NUMERIC_INVALID"});
        }
    }
    json!({"ok": true, "metrics": rows.iter().map(normalize).collect::<Vec<_>>()})
}

fn main() {
    let mut bytes = Vec::new();
    let response = match io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        Ok(_) if (bytes.len() as u64) <= MAX_REQUEST_BYTES => {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(req) => process(&req),
                Err(_) => json!({"ok": false, "code": "JSON_INVALID"}),
            }
        }
        _ => json!({"ok": false, "code": "REQUEST_TOO_LARGE"}),
    };
    println!("{response}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_is_never_charged_without_transport_scope() {
        let v = normalize(&json!({"engine":"openai-sol","inputTokens":200,"costUsd":99.0}));
        assert_eq!(v["cost_kind"], "review_receiving_side");
        assert!(v["tokens_in"].is_null());
        let v = normalize(
            &json!({"engine":"chatgpt-sol","usageScope":"sender","sendInputTokens":20.8,"sendCostUsd":0.12}),
        );
        assert_eq!(v["tokens_in"], 20);
        assert_eq!(v["cost_usd"], 0.12);
    }

    #[test]
    fn rejects_unexpected_telemetry_fields() {
        let v = process(
            &json!({"schema":"singularity-model-usage/v1","rows":[{"engine":"openai","prompt":"secret"}]}),
        );
        assert_eq!(v["code"], "UNEXPECTED_FIELD");
    }

    #[test]
    fn non_sol_metrics_keep_original_token_shapes() {
        let v = normalize(
            &json!({"engine":"opencode-go","model":"foo/bar","inputTokens":33,"outputTokens":12,"costUsd":-1}),
        );
        assert_eq!(v["provider"], "foo");
        assert_eq!(v["tokens_in"], 33);
        assert_eq!(v["cost_kind"], "unknown");
    }
}
