//! Pure closeout source-to-document mapping from harness/kit/lib/doc-impact.mjs.
//! Unmapped means unclassified, never implicit "no impact".
use serde_json::{json, Value};

const ORCH: &[&str] = &["documentation/ai-orchestration.md"];
const ORCH_COMMANDS: &[&str] = &[
    "documentation/ai-orchestration.md",
    "documentation/orchestra-commands.md",
];
const REPOQL: &[&str] = &[
    "documentation/ai-orchestration.md",
    "documentation/tools/repoql-usage.md",
];
const REPOQL_ONLY: &[&str] = &["documentation/tools/repoql-usage.md"];
const SOL: &[&str] = &[
    "documentation/services/catgpt_gateway.md",
    "documentation/ai-orchestration.md",
];
const SOL_ONLY: &[&str] = &["documentation/services/catgpt_gateway.md"];
const LESSONS: &[&str] = &[
    "documentation/orchestra-lessons.md",
    "documentation/ai-orchestration.md",
];

fn docs(path: &str) -> Option<&'static [&'static str]> {
    match path {
        "orchestrate.mjs" | "lib/engine-router.mjs" => Some(ORCH_COMMANDS),
        "config.json"
        | "lib/case-state.mjs"
        | "lib/case-store.mjs"
        | "lib/approval-artifact.mjs"
        | "lib/policy-identity.mjs"
        | "lib/payload-budget.mjs"
        | "lib/plan-cache.mjs"
        | "lib/nanny.mjs"
        | "lib/start-guard.mjs" => Some(ORCH),
        "lib/repoql-client.mjs" | "lib/concept-capture.mjs" => Some(REPOQL),
        "openai-sol-bridge.sh" => Some(SOL),
        "lib/sol-humanize.mjs" => Some(SOL_ONLY),
        "lib/debrief.mjs" => Some(LESSONS),
        _ if path.starts_with(".repoql/concepts/") => Some(REPOQL_ONLY),
        _ if path.starts_with("prompts/") => Some(ORCH),
        _ => None,
    }
}

pub fn classify(changed_files: &Value) -> Result<Value, &'static str> {
    let Some(rows) = changed_files.as_array() else {
        return Err("INVALID_CHANGED_FILES");
    };
    let mut entries = Vec::new();
    let mut unmapped = Vec::new();
    for row in rows {
        let path = row
            .as_str()
            .or_else(|| row.get("path").and_then(Value::as_str))
            .ok_or("INVALID_CHANGED_FILE_PATH")?;
        let relative = path.strip_prefix("work/ai-orchestration/").unwrap_or(path);
        match docs(relative) {
            Some(found) => entries.push(json!({
                "path":relative,"docs":found,"disposition":"review-required"
            })),
            None => unmapped.push(relative.to_string()),
        }
    }
    Ok(json!({"entries":entries,"unmapped":unmapped}))
}

pub fn render(classification: &Value) -> Result<String, &'static str> {
    let entries = classification
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("INVALID_DOC_CLASSIFICATION")?;
    let unmapped = classification
        .get("unmapped")
        .and_then(Value::as_array)
        .ok_or("INVALID_DOC_CLASSIFICATION")?;
    let mut lines = vec!["## Source-to-doc impact classification".to_string()];
    for entry in entries {
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .ok_or("INVALID_DOC_ENTRY")?;
        let docs = entry
            .get("docs")
            .and_then(Value::as_array)
            .ok_or("INVALID_DOC_ENTRY")?;
        let disposition = entry
            .get("disposition")
            .and_then(Value::as_str)
            .ok_or("INVALID_DOC_ENTRY")?;
        let values = docs
            .iter()
            .map(|d| d.as_str().ok_or("INVALID_DOC_ENTRY"))
            .collect::<Result<Vec<_>, _>>()?;
        lines.push(format!("- {path} -> {} [{disposition}]", values.join(", ")));
    }
    if !unmapped.is_empty() {
        let names = unmapped
            .iter()
            .map(|x| x.as_str().ok_or("INVALID_DOC_ENTRY"))
            .collect::<Result<Vec<_>, _>>()?;
        lines.push(format!(
            "- UNMAPPED (unclassified, NOT no-impact — human classification required): {}",
            names.join(", ")
        ));
    }
    if entries.is_empty() && unmapped.is_empty() {
        lines.push("- (no changed files classified)".to_string());
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_known_and_unknown() {
        let result = classify(&json!(["config.json", "lib/debrief.mjs", "other.mjs"])).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 2);
        assert_eq!(result["unmapped"], json!(["other.mjs"]));
        assert!(render(&result).unwrap().contains("UNMAPPED"));
    }
    #[test]
    fn no_implicit_no_impact() {
        assert!(render(&classify(&json!([])).unwrap())
            .unwrap()
            .contains("no changed files classified"));
        assert!(classify(&json!({})).is_err());
    }
}
