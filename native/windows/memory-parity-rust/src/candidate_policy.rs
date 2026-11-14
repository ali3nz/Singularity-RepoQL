//! Provenance and lifecycle eligibility from memory-candidate-v2.mjs.
//! This module never writes candidates or synthesizes evidence timestamps.
use serde_json::{json, Value};

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.),
        _ => true,
    }
}
fn provenance(cand: &Value) -> Vec<&Value> {
    cand.get("provenance")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|r| !r.get("error").is_some_and(truthy))
                .collect()
        })
        .unwrap_or_default()
}
fn anchored(p: &Value) -> bool {
    ["uri", "caseId", "runId", "evidenceSha256"]
        .iter()
        .any(|k| p.get(*k).is_some_and(truthy))
}
pub fn anchored_provenance(cand: &Value) -> bool {
    provenance(cand).iter().any(|p| anchored(p))
}
pub fn derived_provenance(cand: &Value) -> bool {
    let rows = provenance(cand);
    !rows.is_empty()
        && rows
            .iter()
            .all(|p| p.get("kind").and_then(Value::as_str) == Some("derived"))
}
pub fn independent_provenance(cand: &Value, exclude_uri: Option<&str>) -> bool {
    provenance(cand).iter().any(|p| {
        if p.get("kind").and_then(Value::as_str) == Some("derived") {
            return false;
        }
        !matches!((exclude_uri, p.get("uri").and_then(Value::as_str)),
                  (Some(excluded), Some(uri)) if !uri.is_empty() && uri == excluded)
    })
}
pub fn precedence_rank(cand: &Value) -> Option<i64> {
    // The source precedenceRank sees all provenance entries, including a
    // malformed entry carrying an error marker. Governance validation is a
    // separate gate and must not be silently rewritten by this pure port.
    cand.get("provenance")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let kind = p
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_uppercase()
                .replace('-', "_");
            match kind.as_str() {
                "LIVE_EVIDENCE" => Some(100),
                "OPERATOR_DECISION" => Some(95),
                "CURRENT_HUB_DOC" => Some(80),
                "VERIFIED_CONCEPT" => Some(70),
                "JOURNAL_EVENT" => Some(40),
                "CONVERSATION" => Some(20),
                _ => None,
            }
        })
        .max()
}
pub fn assess(input: &Value) -> Value {
    let cand = input.get("candidate").unwrap_or(&Value::Null);
    let exclude = input.get("excludeUri").and_then(Value::as_str);
    json!({"ok":true,
        "hasAnchoredProvenance":anchored_provenance(cand),
        "isDerivedProvenance":derived_provenance(cand),
        "hasIndependentProvenance":independent_provenance(cand, exclude),
        "precedenceRank":precedence_rank(cand),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn self_referential_memory_cannot_supply_independent_evidence() {
        let data = json!({"candidate":{"provenance":[{"kind":"derived","uri":"a"},{"kind":"live-evidence","uri":"concept:///self"}]}, "excludeUri":"concept:///self"});
        let out = assess(&data);
        assert_eq!(out["hasAnchoredProvenance"], true);
        assert_eq!(out["isDerivedProvenance"], false);
        assert_eq!(out["hasIndependentProvenance"], false);
        assert_eq!(out["precedenceRank"], 100);
    }
    #[test]
    fn derived_only_never_becomes_independent() {
        let data = json!({"candidate":{"provenance":[{"kind":"derived","uri":"concept:///x"}]}});
        let out = assess(&data);
        assert_eq!(out["isDerivedProvenance"], true);
        assert_eq!(out["hasIndependentProvenance"], false);
    }
    #[test]
    fn an_error_marker_is_not_valid_provenance() {
        let data = json!({"candidate":{"provenance":[{"error":"malformed","uri":"a"}]}});
        let out = assess(&data);
        assert_eq!(out["hasAnchoredProvenance"], false);
        assert_eq!(out["precedenceRank"], Value::Null);
    }
}
