//! Source-to-document impact mapping from kit/lib/doc-impact.mjs.
//! Unknown files are *unmapped*, never interpreted as no impact.
use crate::deviation::js_text;
use serde_json::{json, Value};

fn docs(path: &str) -> Option<&'static [&'static str]> {
    const AI: &str = "documentation/ai-orchestration.md";
    const COMMANDS: &str = "documentation/orchestra-commands.md";
    const REPOQL: &str = "documentation/tools/repoql-usage.md";
    const GATEWAY: &str = "documentation/services/catgpt_gateway.md";
    const LESSONS: &str = "documentation/orchestra-lessons.md";
    match path {
        "orchestrate.mjs" => Some(&[AI, COMMANDS]),
        "config.json"
        | "lib/case-state.mjs"
        | "lib/case-store.mjs"
        | "lib/approval-artifact.mjs"
        | "lib/policy-identity.mjs"
        | "lib/payload-budget.mjs"
        | "lib/plan-cache.mjs"
        | "lib/nanny.mjs"
        | "lib/start-guard.mjs" => Some(&[AI]),
        "lib/engine-router.mjs" => Some(&[AI, COMMANDS]),
        "lib/repoql-client.mjs" | "lib/concept-capture.mjs" => Some(&[AI, REPOQL]),
        "openai-sol-bridge.sh" => Some(&[GATEWAY, AI]),
        "lib/sol-humanize.mjs" => Some(&[GATEWAY]),
        "lib/debrief.mjs" => Some(&[LESSONS, AI]),
        _ if path.starts_with(".repoql/concepts/") => Some(&[REPOQL]),
        _ if path.starts_with("prompts/") => Some(&[AI]),
        _ => None,
    }
}

pub fn classify(changed: &Value) -> Value {
    let mut entries = Vec::new();
    let mut unmapped = Vec::new();
    let Some(files) = changed.as_array() else {
        return json!({"error":"changedFiles must be an array"});
    };
    for file in files {
        // JS: String(f.path ?? f).replace(/^work\/ai-orchestration\//, "")
        let val = file.get("path").filter(|v| !v.is_null()).unwrap_or(file);
        let raw = js_text(Some(val));
        let rel = raw.strip_prefix("work/ai-orchestration/").unwrap_or(&raw);
        if let Some(d) = docs(rel) {
            entries.push(json!({"path":rel,"docs":d,"disposition":"review-required"}));
        } else {
            unmapped.push(rel.to_owned());
        }
    }
    json!({"entries":entries,"unmapped":unmapped})
}

pub fn render(classification: &Value) -> Value {
    let Some(entries) = classification.get("entries").and_then(Value::as_array) else {
        return json!({"error":"missing entries"});
    };
    let Some(unmapped) = classification.get("unmapped").and_then(Value::as_array) else {
        return json!({"error":"missing unmapped"});
    };
    let mut lines = vec!["## Source-to-doc impact classification".to_owned()];
    for e in entries {
        let path = js_text(e.get("path"));
        let docs = e
            .get("docs")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|v| js_text(Some(v)))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let disposition = js_text(e.get("disposition"));
        lines.push(format!("- {path} -> {docs} [{disposition}]"));
    }
    if !unmapped.is_empty() {
        let names = unmapped
            .iter()
            .map(|v| js_text(Some(v)))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "- UNMAPPED (unclassified, NOT no-impact — human classification required): {names}"
        ));
    }
    if entries.is_empty() && unmapped.is_empty() {
        lines.push("- (no changed files classified)".to_owned());
    }
    json!(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_is_not_automatic_no_impact() {
        let x = classify(&json!(["kit/lib/unmapped-file.mjs"]));
        assert_eq!(x["unmapped"][0], "kit/lib/unmapped-file.mjs");
        assert_eq!(x["entries"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn known_engine_router_maps_two_documents() {
        let x = classify(&json!([{"path":"work/ai-orchestration/lib/engine-router.mjs"}]));
        assert_eq!(x["entries"][0]["docs"].as_array().unwrap().len(), 2);
    }
}
