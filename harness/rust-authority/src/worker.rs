//! Offline port of kit/lib/worker-completion.mjs.
//! Coordinator acceptance must continue to use the original JS until differential parity is proven.
use regex::Regex;
use serde_json::{json, Value};

const REQUIRED_FIELDS: &[&str] = &[
    "status",
    "changedFiles",
    "criteriaResults",
    "tests",
    "runtimeEvidence",
    "deviations",
    "knownIssues",
    "rollbackPoint",
];
const STATUSES: &[&str] = &["complete", "partial", "failed", "blocked"];

fn object_like(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

pub fn parse(text: &str) -> Value {
    // Source uses String(statusText ?? "").match(/```json\s*\n([\s\S]*?)```/)
    let Ok(pattern) = Regex::new(r"```json\s*\n([\s\S]*?)```") else {
        return Value::Null;
    };
    let Some(capture) = pattern.captures(text) else {
        return Value::Null;
    };
    let Some(body) = capture.get(1) else {
        return Value::Null;
    };
    let Ok(raw) = serde_json::from_str::<Value>(body.as_str()) else {
        return Value::Null;
    };
    let record = raw.get("workerCompletion").cloned().unwrap_or(Value::Null);
    if object_like(&record) {
        record
    } else {
        Value::Null
    }
}

pub fn validate(record: &Value) -> Vec<String> {
    if !object_like(record) {
        return vec!["record not an object".to_string()];
    }
    let mut problems = Vec::new();
    for name in REQUIRED_FIELDS {
        if record.get(name).is_none() {
            problems.push(format!("missing required field: {name}"));
        }
    }
    if let Some(status) = record.get("status") {
        if !status.as_str().is_some_and(|s| STATUSES.contains(&s)) {
            problems.push(format!("status must be one of {}", STATUSES.join("|")));
        }
    }
    for name in ["changedFiles", "deviations"] {
        if record.get(name).is_some_and(|v| !v.is_array()) {
            problems.push(format!("{name} must be an array"));
        }
    }
    if let Some(criteria) = record.get("criteriaResults") {
        if let Some(entries) = criteria.as_array() {
            for entry in entries {
                // The source deliberately allows null/false/zero; only truthy primitives fail.
                if !object_like(entry)
                    && !entry.is_null()
                    && entry != &json!(false)
                    && entry != &json!(0)
                    && entry != &json!("")
                {
                    problems.push("criteriaResults entries must be objects".to_string());
                }
            }
        } else {
            problems.push("criteriaResults must be an array".to_string());
        }
    }
    problems
}

pub fn extract(texts: &Value) -> Value {
    let input: Vec<Value> = if let Some(arr) = texts.as_array() {
        arr.clone()
    } else {
        vec![texts.clone()]
    };
    for (index, text) in input.iter().enumerate() {
        let raw = text.as_str().unwrap_or("");
        let completion = parse(raw);
        if !completion.is_null() {
            let problems = validate(&completion);
            return json!({"found":true,"completion":completion,"fromIndex":index,"problems":problems});
        }
    }
    json!({"found":false,"completion":null,"fromIndex":-1,"problems":["no workerCompletion block in any status text"]})
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub fn decision(extraction: &Value) -> Value {
    if extraction.get("found") != Some(&json!(true)) {
        return json!({"allow":false,"reason":"NO_COMPLETION_RECORD","advisory":"prose-only completion claims do not pass"});
    }
    let problems = extraction.get("problems").and_then(Value::as_array);
    if let Some(items) = problems {
        if !items.is_empty() {
            let detail = items.iter().map(js_string).collect::<Vec<_>>().join("; ");
            return json!({"allow":false,"reason":"INVALID_COMPLETION_RECORD","detail":detail});
        }
    }
    let completion = extraction.get("completion").unwrap_or(&Value::Null);
    let status = completion
        .get("status")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into());
    if status != "complete" {
        return json!({"allow":false,"reason":format!("STATUS_{}",status.to_uppercase())});
    }
    if let Some(criteria) = completion.get("criteriaResults").and_then(Value::as_array) {
        let failed: Vec<_> = criteria
            .iter()
            .filter(|c| c.get("pass") == Some(&json!(false)))
            .collect();
        if !failed.is_empty() {
            let ids = failed
                .iter()
                .map(|c| {
                    c.get("criterionId")
                        .filter(|v| !v.is_null())
                        .map(js_string)
                        .unwrap_or_else(|| "?".into())
                })
                .collect::<Vec<_>>();
            return json!({"allow":false,"reason":"FAILED_CRITERIA","detail":ids.join(",")});
        }
    }
    if let Some(issues) = completion.get("knownIssues").and_then(Value::as_array) {
        let pattern = Regex::new("(?i)block").expect("constant regex");
        let blocked: Vec<_> = issues
            .iter()
            .map(js_string)
            .filter(|s| pattern.is_match(s))
            .collect();
        if !blocked.is_empty() {
            let detail = blocked.join("; ").chars().take(160).collect::<String>();
            return json!({"allow":false,"reason":"BLOCKING_KNOWN_ISSUE","detail":detail});
        }
    }
    json!({"allow":true,"reason":"OK"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_criterion_blocks_completion() {
        let rec = json!({"found":true,"problems":[],"completion":{
            "status":"complete", "criteriaResults":[{"criterionId":"required","pass":false}],"knownIssues":[]}});
        assert_eq!(decision(&rec)["reason"], "FAILED_CRITERIA");
    }
    #[test]
    fn prose_cannot_override_missing_record() {
        let extraction = extract(&json!(["Work is done. All checks passed."]));
        assert_eq!(decision(&extraction)["reason"], "NO_COMPLETION_RECORD");
    }
}
