//! Pure scope matching from kit/lib/run-slots.mjs (K6).
//! Does not implement run slot acquisition, leases or liveness.
use serde_json::{json, Value};

pub fn parse(text: &str) -> Vec<String> {
    text.split(',')
        .map(|x| x.trim().trim_end_matches('/').to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn scope_list(value: &Value) -> Vec<String> {
    if let Some(arr) = value.as_array() {
        arr.iter()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .collect()
    } else {
        parse(value.as_str().unwrap_or(""))
    }
}

pub fn overlaps(a: &Value, b: &Value) -> bool {
    let first = scope_list(a);
    let second = scope_list(b);
    first.iter().any(|x| {
        second
            .iter()
            .any(|y| x == y || x.starts_with(&format!("{y}/")) || y.starts_with(&format!("{x}/")))
    })
}

pub fn decision(mine: &Value, others: &Value) -> Value {
    let my_scope = scope_list(mine);
    let Some(other_runs) = others.as_array() else {
        return json!({"action":"ok","with":[],"message":""});
    };
    if other_runs.is_empty() {
        return json!({"action":"ok","with":[],"message":""});
    }
    let mut refuse: Vec<String> = Vec::new();
    let mut warn: Vec<String> = Vec::new();
    for other in other_runs {
        let theirs = scope_list(other.get("scope").unwrap_or(&Value::Null));
        let id = other
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("undefined")
            .to_string();
        if !my_scope.is_empty() && !theirs.is_empty() {
            if overlaps(&json!(my_scope), &json!(theirs)) {
                refuse.push(id);
            }
        } else {
            warn.push(id);
        }
    }
    if !refuse.is_empty() {
        return json!({"action":"refuse","with":refuse,"message":format!("declared scope overlaps run {} — refusing the second start", refuse.join(", "))});
    }
    if !warn.is_empty() {
        return json!({"action":"warn","with":warn,"message":format!("WARNING: concurrent run {} active (scope undeclared) — coordinate on shared files",warn.join(", "))});
    }
    json!({"action":"ok","with":[],"message":""})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_paths_overlap_not_siblings() {
        assert!(overlaps(&json!("kit/lib"), &json!("kit/lib/nanny")));
        assert!(!overlaps(&json!("kit/lib"), &json!("kit/library")));
    }
    #[test]
    fn undeclared_scope_only_warns() {
        let result = decision(&json!("kit/lib"), &json!([{"runId":"one","scope":""}]));
        assert_eq!(result["action"], "warn");
    }
}
