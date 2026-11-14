//! Pure current-truth lineage retrieval policy.
//!
//! The native storage reader must provide the verified state for every requested
//! record before this function is called. No claim about disk authority is made
//! here. In historical and REVIEW modes stale/invalid lineage is intentionally
//! retained, matching the read-only provenance contract.
use serde_json::{json, Value};

pub fn filter_record_names(input: &Value) -> Value {
    let names = input
        .get("recordNames")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let states = input.get("states").and_then(Value::as_object);
    let historical = input
        .get("historicalMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || input.get("stage").and_then(Value::as_str) == Some("REVIEW");
    let mut kept = Vec::new();
    let mut excluded = Vec::new();
    for name in names {
        let key = name.as_str().unwrap_or("");
        let state = states
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .unwrap_or("legacy_unknown");
        if !historical && (state == "invalid" || state == "stale") {
            excluded.push(json!({"name":name,"state":state}));
        } else {
            kept.push(name);
        }
    }
    json!({"ok":true,"kept":kept,"excluded":excluded,"historical":historical})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_excludes_only_invalid_and_stale() {
        let x = json!({"recordNames":["a","b","c","d"],"states":{"a":"known","b":"invalid","c":"stale"}});
        let v = filter_record_names(&x);
        assert_eq!(v["kept"], json!(["a", "d"]));
        assert_eq!(
            v["excluded"],
            json!([{"name":"b","state":"invalid"},{"name":"c","state":"stale"}])
        );
    }
    #[test]
    fn historical_and_review_restore_stale_records() {
        let base = json!({"recordNames":["a"],"states":{"a":"stale"}});
        let mut historical = base.clone();
        historical["historicalMode"] = json!(true);
        assert_eq!(filter_record_names(&historical)["kept"], json!(["a"]));
        let mut review = base;
        review["stage"] = json!("REVIEW");
        assert_eq!(filter_record_names(&review)["kept"], json!(["a"]));
    }
}

/// Read-only lineage graph calculations against an already authorized snapshot.
/// Sidecars are ordered by their caller-provided stable file order. The source
/// runtime's storage reader is responsible for authority, parsing and bounds.
/// This function neither fetches remote records nor persists state.
pub fn inspect_graph(input: &Value) -> Value {
    use std::collections::{HashMap, HashSet};
    let root = input.get("recordId").and_then(Value::as_str).unwrap_or("");
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("descendants");
    let depth_bound = input
        .get("maxDepth")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(32)
        .min(32);
    let sidecars = input
        .get("sidecars")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut parents: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for side in sidecars {
        let Some(id) = side.get("recordId").and_then(Value::as_str) else {
            continue;
        };
        let mut direct = Vec::new();
        let mut seen = HashSet::new();
        for field in ["derivedFrom", "sourceClaimIds"] {
            if let Some(items) = side.get(field).and_then(Value::as_array) {
                for item in items {
                    if let Some(parent) = item.as_str() {
                        if seen.insert(parent) {
                            direct.push(parent);
                        }
                    }
                }
            }
        }
        for parent in &direct {
            let siblings = children.entry(parent).or_default();
            if !siblings.contains(&id) {
                siblings.push(id);
            }
        }
        parents.insert(id, direct);
    }
    let edges = if mode == "ancestors" {
        &parents
    } else {
        &children
    };
    let mut visited = HashSet::new();
    let mut result: Vec<&str> = Vec::new();
    let mut frontier = vec![root];
    for _ in 0..depth_bound {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for node in frontier {
            for related in edges.get(node).into_iter().flat_map(|v| v.iter().copied()) {
                if related == root {
                    if mode == "ancestors" {
                        return json!({"ok":false,"code":"CYCLE_DETECTED","ancestors":result,"depthExceeded":false});
                    }
                    return json!({"ok":false,"code":"CYCLE_DETECTED","descendants":result,"depthExceeded":false});
                }
                if visited.insert(related) {
                    result.push(related);
                    next.push(related);
                }
            }
        }
        frontier = next;
    }
    let exceeded = !frontier.is_empty();
    if mode == "ancestors" {
        json!({"ok":true,"ancestors":result,"depthExceeded":exceeded})
    } else {
        json!({"ok":true,"descendants":result,"depthExceeded":exceeded})
    }
}

#[cfg(test)]
mod graph_tests {
    use super::*;
    #[test]
    fn descendants_avoid_duplicate_paths() {
        let x = json!({"recordId":"Root","sidecars":[
            {"recordId":"A","derivedFrom":["Root"]},
            {"recordId":"B","derivedFrom":["Root"]},
            {"recordId":"C","sourceClaimIds":["A","B"]}
        ]});
        let out = inspect_graph(&x);
        assert_eq!(out["descendants"], json!(["A", "B", "C"]));
    }
    #[test]
    fn traversal_cycles_fail_closed() {
        let x = json!({"recordId":"Root","sidecars":[
            {"recordId":"A","derivedFrom":["Root"]},
            {"recordId":"Root","derivedFrom":["A"]}
        ]});
        assert_eq!(inspect_graph(&x)["code"], "CYCLE_DETECTED");
    }
}
