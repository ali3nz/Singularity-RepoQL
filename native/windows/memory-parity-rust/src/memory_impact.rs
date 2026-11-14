//! Deterministic read-only memory impact scoring from memory-impact.mjs.
//! The caller supplies already-read knowledge files, preventing this module
//! from accidentally broadening filesystem or authority access.
use serde_json::{json, Value};
use std::collections::HashSet;

fn eligible(token: &str) -> bool {
    token.len() >= 4
        && !matches!(
            token,
            "index" | "test" | "tests" | "node_modules" | "lib" | "src"
        )
}

fn path_part(part: &str) -> String {
    // The source removes one final ASCII alphabetic extension, not arbitrary dots.
    let root = match part.rsplit_once('.') {
        Some((root, ext)) if !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphabetic()) => {
            root
        }
        _ => part,
    };
    root.to_lowercase()
}

pub fn scope_tokens(changed_files: &[Value], hint: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |token: String| {
        if eligible(&token) && seen.insert(token.clone()) {
            out.push(token);
        }
    };
    for file in changed_files {
        for part in file
            .as_str()
            .unwrap_or("")
            .split('/')
            .filter(|p| !p.is_empty())
        {
            add(path_part(part));
        }
    }
    if let Some(hint) = hint {
        for part in hint
            .to_lowercase()
            .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        {
            if part.len() >= 4 {
                add(part.to_owned());
            }
        }
    }
    out
}

pub fn impact(input: &Value) -> Value {
    let changed = input
        .get("changedFiles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let hint = input.get("subsystemHint").and_then(Value::as_str);
    let tokens = scope_tokens(changed, hint);
    let mut impacted: Vec<Value> = Vec::new();
    if tokens.is_empty() {
        return json!({"ok":true,"tokens":tokens,"impacted":impacted});
    }
    let min_score = input.get("minScore").and_then(Value::as_i64).unwrap_or(1);
    if let Some(files) = input.get("knowledgeFiles").and_then(Value::as_array) {
        for row in files {
            let file = row.get("file").and_then(Value::as_str).unwrap_or("");
            let content = row.get("content").and_then(Value::as_str).unwrap_or("");
            let haystack = format!("{file} {content}").to_lowercase();
            let matching: Vec<&str> = tokens
                .iter()
                .map(String::as_str)
                .filter(|tok| haystack.contains(tok))
                .collect();
            let score = matching.len();
            if score as i64 >= min_score {
                let risk = if score >= 3 {
                    "high"
                } else if score == 2 {
                    "medium"
                } else {
                    "low"
                };
                impacted.push(json!({"file":file,"score":score,"matchedTokens":matching.into_iter().take(8).collect::<Vec<_>>(),"staleRisk":risk}));
            }
        }
    }
    impacted.sort_by(|a, b| {
        let ascore = a.get("score").and_then(Value::as_u64).unwrap_or(0);
        let bscore = b.get("score").and_then(Value::as_u64).unwrap_or(0);
        bscore.cmp(&ascore).then_with(|| {
            a["file"]
                .as_str()
                .unwrap_or("")
                .cmp(b["file"].as_str().unwrap_or(""))
        })
    });
    impacted.truncate(12);
    json!({"ok":true,"tokens":tokens,"impacted":impacted})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranked_scoped_impacts() {
        let x = json!({"changedFiles":["harness/kit/lib/context-pack.mjs"],"subsystemHint":"context retrieval", "knowledgeFiles":[{"file":"a.md","content":"harness context retrieval"},{"file":"z.md","content":"context"} ]});
        let out = impact(&x);
        assert_eq!(
            out["tokens"],
            json!(["harness", "context-pack", "context", "retrieval"])
        );
        assert_eq!(out["impacted"][0]["score"], 3);
        assert_eq!(out["impacted"][0]["staleRisk"], "high");
    }
}
