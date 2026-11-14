//! Deterministic evidence-sufficiency verdicts for MemOS answerability.
//!
//! Mirrors `harness/kit/lib/memory-orchestra/answerability.mjs` for the pure
//! first-pass verdict, targeted expansion verdict, and conflict detection.
//! The optional LLM downgrade and all retrieval/expansion remain in the
//! original application. This module never searches, writes, or authorizes.
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const CHANNEL_DIMENSIONS: &[(&str, &str)] = &[
    ("error-signature-exact", "exact-match"),
    ("exact-identifier", "exact-match"),
    ("recipe-runbook", "procedure"),
    ("procedure-runbook", "procedure"),
    ("skill-approved", "procedure"),
    ("repoql-code-symbol", "authority"),
    ("repoql-concept", "authority"),
    ("docs-current", "procedure"),
    ("episode-historical", "episode-evidence"),
    ("tencent-l0-keyword", "episode-evidence"),
    ("tencent-l1-semantic", "pattern"),
    ("policy-insight", "pattern"),
    ("temporal-fact", "temporal-evidence"),
    ("entity-relationship", "authority"),
];

fn dims(intent: &str) -> Vec<&'static str> {
    match intent {
        "exact" => vec!["exact-match"],
        "how-to" => vec!["procedure", "authority"],
        "what-happened" => vec!["episode-evidence"],
        "why-recurring" => vec!["pattern", "episode-evidence"],
        "where-am-i" => vec!["authority"],
        "temporal" => vec!["temporal-evidence"],
        _ => vec!["episode-evidence"],
    }
}

fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn js_string(v: Option<&Value>, default: &str) -> String {
    match v {
        None | Some(Value::Null) => default.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| js_string(Some(x), ""))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

fn candidates(fused: Option<&Value>) -> &[Value] {
    fused
        .and_then(|f| f.get("candidates"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn judge_packet(input: &Value) -> Value {
    let fused = input.get("fused");
    if !js_truthy(fused.and_then(|f| f.get("ok"))) {
        let reason = fused
            .and_then(|f| f.get("code"))
            .filter(|c| !c.is_null())
            .cloned()
            .unwrap_or_else(|| json!("no fused packet"));
        return json!({"state":"INSUFFICIENT","reason":reason,"missing":[],"targetedExpansion":null});
    }
    let kept = candidates(fused);
    if kept.is_empty() {
        return json!({"state":"INSUFFICIENT","reason":"zero gate-keeping candidates","missing":[],"targetedExpansion":null});
    }
    let intent = js_string(
        input.get("plan").and_then(|p| p.get("intent")),
        "what-happened",
    );
    let required = dims(&intent);
    let mut covered: Vec<&str> = Vec::new();
    for row in kept {
        let ch = row.get("channel").and_then(Value::as_str).unwrap_or("");
        if let Some((_, dim)) = CHANNEL_DIMENSIONS.iter().find(|(name, _)| *name == ch) {
            if !covered.contains(dim) {
                covered.push(dim);
            }
        }
        if js_truthy(row.get("exact")) && !covered.contains(&"exact-match") {
            covered.push("exact-match");
        }
    }
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|d| !covered.contains(d))
        .collect();
    if missing.is_empty() {
        return json!({"state":"SUFFICIENT","reason":format!("all required dims covered ({})",covered.join("+")),
            "missing":[],"targetedExpansion":null,"dimCoverage":{"dims":required,"covered":covered}});
    }
    let targeted = match missing[0] {
        "exact-match" => "error-signature-exact",
        "procedure" => "procedure-runbook",
        "episode-evidence" => "episode-historical",
        "pattern" => "policy-insight",
        "authority" => "repoql-concept",
        "temporal-evidence" => "temporal-fact",
        _ => "",
    };
    json!({"state":"PARTIAL","reason":format!("missing dims: {}",missing.join(",")),
        "missing":missing,"targetedExpansion":if targeted.is_empty() { Value::Null } else { json!(targeted) },
        "dimCoverage":{"dims":required,"covered":covered},"conflicts":[]})
}

// The JS source uses String(claimText ?? "").toLowerCase().split(/\s+/)
// and preserves an empty first token when the claim begins with whitespace.
fn subject_key(row: &Value, splitter: &Regex) -> String {
    let s = js_string(row.get("claimText"), "").to_lowercase();
    splitter.split(&s).take(12).collect::<Vec<_>>().join(" ")
}

pub fn detect_conflicts(input: &Value) -> Value {
    let rows = input
        .get("candidates")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let splitter = Regex::new(r"\s+").expect("constant regex");
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let key = subject_key(row, &splitter);
        if let Some(&pos) = positions.get(&key) {
            groups[pos].1.push(row);
        } else {
            positions.insert(key.clone(), groups.len());
            groups.push((key, vec![row]));
        }
    }
    for (subject, group) in groups {
        if group.len() < 2 {
            continue;
        }
        let mut validity: Vec<String> = Vec::new();
        for row in &group {
            let state = js_string(row.get("validity"), "CURRENT").to_uppercase();
            if !validity.contains(&state) {
                validity.push(state);
            }
        }
        if validity.len() < 2 {
            continue;
        }
        let mut values = Vec::new();
        for row in group {
            let mut entry = Map::new();
            for name in ["id", "origin", "channel", "validity"] {
                if let Some(value) = row.get(name) {
                    entry.insert(name.to_owned(), value.clone());
                }
            }
            values.push(Value::Object(entry));
        }
        return json!([{"subject":subject,"candidates":values}]);
    }
    json!([])
}

pub fn judge_expanded(input: &Value) -> Value {
    let fused = input.get("fused");
    let base = judge_packet(input);
    let conflicts = detect_conflicts(&json!({"candidates":candidates(fused)}));
    let Some(first) = conflicts.as_array().and_then(|rows| rows.first()) else {
        return base;
    };
    let subject = first.get("subject").and_then(Value::as_str).unwrap_or("");
    let reason = js_string(base.get("reason"), "");
    let mut result = base;
    result["state"] = json!("CONFLICTED");
    result["reason"] = json!(format!("{reason}; validity conflict detected ({subject})"));
    result["conflicts"] = conflicts;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_coverage() {
        let only_procedure = json!({"plan":{"intent":"how-to"},"fused":{"ok":true,"candidates":[
            {"channel":"procedure-runbook","claimText":"run tests"}]}});
        let result = judge_packet(&only_procedure);
        assert_eq!(result["state"], "PARTIAL");
        assert_eq!(result["targetedExpansion"], "repoql-concept");
        assert_eq!(result["missing"], json!(["authority"]));
        let both = json!({"plan":{"intent":"how-to"},"fused":{"ok":true,"candidates":[
            {"channel":"repoql-concept"},{"channel":"procedure-runbook"}]}});
        assert_eq!(judge_packet(&both)["state"], "SUFFICIENT");
    }
    #[test]
    fn validity_disagreement_is_conflicted_only_after_expansion() {
        let input = json!({"plan":{"intent":"what-happened"},"fused":{"ok":true,"candidates":[
            {"id":"a","channel":"episode-historical","claimText":"service enabled","validity":"CURRENT"},
            {"id":"b","channel":"repoql-concept","claimText":"service enabled","validity":"STALE"}]}});
        assert_eq!(judge_packet(&input)["state"], "SUFFICIENT");
        assert_eq!(judge_expanded(&input)["state"], "CONFLICTED");
    }
    #[test]
    fn no_evidence_never_is_promoted() {
        assert_eq!(
            judge_packet(&json!({"fused":{"ok":false,"code":"GATE_DROP"}}))["state"],
            "INSUFFICIENT"
        );
        assert_eq!(
            judge_packet(&json!({"fused":{"ok":true,"candidates":[]}}))["state"],
            "INSUFFICIENT"
        );
    }
}
