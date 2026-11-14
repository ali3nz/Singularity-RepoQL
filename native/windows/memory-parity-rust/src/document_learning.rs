//! Pure documentation and self-learning identity policies.
//!
//! This module never reads workspaces, chooses a task stage, verifies a
//! document ledger, or writes a concept. Both policies are opt-in and their
//! results must equal the existing JavaScript owner before use.
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

fn invalid() -> Value {
    json!({"ok":false,"code":"INVALID_DOCUMENT_LEARNING_INPUT"})
}

const SKIP_EXTS: &[&str] = &[
    ".md", ".mdx", ".txt", ".rst", ".log", ".lock", ".sum", ".png", ".jpg", ".jpeg", ".gif",
    ".svg", ".ico", ".woff", ".woff2",
];
const SKIP_FILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "SHA256SUMS",
    "MANIFEST.json",
];
const SKIP_PARTS: &[&str] = &[
    "__pycache__",
    ".git",
    ".repoql",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "gen",
    "generated",
    "snapshots",
    "site-packages",
    ".venv",
    "venv",
    ".tox",
    "coverage",
    ".next",
];

// Node path.extname preserves dotfiles as extensionless, regardless of the
// underlying Windows or POSIX separator convention.
fn extension(path: &str, windows: bool) -> String {
    let name = path
        .rsplit(|c| c == '/' || (windows && c == '\\'))
        .next()
        .unwrap_or("");
    match name.rfind('.') {
        Some(0) | None => String::new(),
        Some(pos) => name[pos..].to_ascii_lowercase(),
    }
}

fn runtime_state(path: &str) -> bool {
    // Equivalent to RUNTIME_STATE_RE in scripts/doc-policy.mjs.
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    parts.iter().enumerate().any(|(i, part)| {
        (*part == ".repoql" && i + 1 < parts.len())
            || (*part == "data"
                && i + 2 < parts.len()
                && matches!(
                    parts[i + 1],
                    "selflearn"
                        | "doc-policy"
                        | "doc-index"
                        | "opencode"
                        | "agent-backups"
                        | "attach-backups"
                        | "acceptance"
                ))
    })
}

/// Exact path classification of the existing shared Node documentation gate.
/// Returns the original path strings, preserving order, with no file reads.
pub fn classify(input: &Value) -> Value {
    let Some(files) = input.get("files").and_then(Value::as_array) else {
        return invalid();
    };
    if files.len() > 10_000 {
        return invalid();
    }
    let windows = input.get("platform").and_then(Value::as_str) == Some("win32");
    let backup = Regex::new(r"(?i)\.bak|~$|-backup\.|\.tmp$").expect("fixed backup regex");
    let mut material = Vec::new();
    let mut skipped = Vec::new();
    let mut docs_only = true;
    for file in files {
        let Some(path) = file.as_str() else {
            return invalid();
        };
        // Existing classifyFiles intentionally splits the basename at forward
        // slashes only, while its directory check accepts both separators.
        let base = path.rsplit('/').next().unwrap_or("");
        let ext = extension(base, windows);
        let doc_ext = extension(path, windows);
        if !SKIP_EXTS.contains(&doc_ext.as_str()) {
            docs_only = false;
        }
        let parts: Vec<&str> = path.split(['/', '\\']).collect();
        let skip = SKIP_FILES.contains(&base)
            || SKIP_EXTS.contains(&ext.as_str())
            || parts.iter().any(|part| SKIP_PARTS.contains(part))
            || runtime_state(path)
            || base.contains(".min.")
            || backup.is_match(base);
        if skip {
            skipped.push(path.to_owned());
        } else {
            material.push(path.to_owned());
        }
    }
    json!({"ok":true,"material":material,"skipped":skipped,"docsOnly":docs_only})
}

/// The native Windows path-list delimiter is ';' and must not split C: roots.
pub fn doc_roots(input: &Value) -> Value {
    let (Some(raw), Some(platform)) = (
        input.get("raw").and_then(Value::as_str),
        input.get("platform").and_then(Value::as_str),
    ) else {
        return invalid();
    };
    let separator = if platform == "win32" { ';' } else { ':' };
    let roots: Vec<&str> = raw
        .split(separator)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    json!({"ok":true,"roots":roots})
}

/// Durable self-learning identity from the session and unique sorted paths.
/// JavaScript Array.sort compares UTF-16 code units, not UTF-8 bytes.
pub fn candidate_id(input: &Value) -> Value {
    let (Some(session), Some(files)) = (
        input.get("session").and_then(Value::as_str),
        input.get("files").and_then(Value::as_array),
    ) else {
        return invalid();
    };
    if files.len() > 10_000 {
        return invalid();
    }
    let mut seen = HashSet::new();
    let mut distinct = Vec::new();
    for file in files {
        let Some(value) = file.as_str() else {
            return invalid();
        };
        if seen.insert(value.to_owned()) {
            distinct.push(value);
        }
    }
    distinct.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let session = if session.is_empty() {
        "unknown"
    } else {
        session
    };
    let data = format!(
        "{}\n{}",
        session,
        distinct.into_iter().collect::<Vec<_>>().join("\n")
    );
    let digest = Sha256::digest(data.as_bytes());
    json!({"ok":true,"id":format!("{:02x}{:02x}{:02x}{:02x}",digest[0],digest[1],digest[2],digest[3])})
}

/// Strict validation of a model-proposed lesson. This cannot promote or write
/// a concept. The outer `ok:true` means that an invalid lesson was evaluated
/// correctly; the inner value.ok is the actual lesson verdict.
pub fn validate_lesson(input: &Value) -> Value {
    fn verdict(value: Value) -> Value {
        json!({"ok":true,"value":value})
    }
    fn error(s: impl AsRef<str>) -> Value {
        verdict(json!({"ok":false,"error":s.as_ref()}))
    }
    const SCHEMA: &str = "selflearn.lesson.v1";
    const CATEGORIES: &[&str] = &[
        "bugfix",
        "configuration",
        "architecture",
        "deployment",
        "recovery",
        "testing",
        "other",
    ];
    const FIELDS: &[&str] = &[
        "schema",
        "title",
        "lesson",
        "category",
        "generalizable",
        "confidence",
        "needsVerification",
        "evidenceRefs",
        "duplicateOf",
    ];
    let Some(raw) = input.get("raw").and_then(Value::as_object) else {
        return error("not a JSON object");
    };
    if raw.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return error(format!("schema must be {SCHEMA}"));
    }
    if raw.get("noLesson").and_then(Value::as_bool) == Some(true) {
        if raw.keys().any(|k| k != "schema" && k != "noLesson") {
            return error("noLesson response carries extra fields");
        }
        return verdict(json!({"ok":true,"lesson":{"noLesson":true}}));
    }
    // serde_json sorts object keys without its optional preserve_order feature.
    // The Node caller passes Object.keys(raw) so the first offending field and
    // error text retain the existing JavaScript insertion-order contract.
    let order: Vec<&str> = match input.get("rawKeys").and_then(Value::as_array) {
        Some(keys) => {
            let list: Vec<&str> = keys.iter().filter_map(Value::as_str).collect();
            let unique: HashSet<&str> = list.iter().copied().collect();
            if list.len() != raw.len()
                || unique.len() != raw.len()
                || !unique.iter().all(|key| raw.contains_key(*key))
            {
                return json!({"ok":false,"code":"INVALID_DOCUMENT_LEARNING_INPUT"});
            }
            list
        }
        None => raw.keys().map(String::as_str).collect(),
    };
    let unknown: Vec<&str> = order.into_iter().filter(|k| !FIELDS.contains(k)).collect();
    if !unknown.is_empty() {
        return error(format!("unknown field(s): {}", unknown.join(", ")));
    }
    // ECMAScript String.trim whitespace is not identical to Rust's Unicode
    // is_whitespace predicate (notably U+0085 and U+001C..U+001F).
    let js_space = |c: char| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' |
        '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' |
        '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    };
    let trim_js = |s: &str| s.trim_matches(js_space).to_owned();
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .map(trim_js)
        .unwrap_or_default();
    let text = raw
        .get("lesson")
        .and_then(Value::as_str)
        .map(trim_js)
        .unwrap_or_default();
    if title.is_empty() || title.encode_utf16().count() > 80 {
        return error("title must be 1..80 chars");
    }
    if text.is_empty() || text.encode_utf16().count() > 600 {
        return error("lesson must be 1..600 chars");
    }
    let category = raw.get("category").and_then(Value::as_str).unwrap_or("");
    if !CATEGORIES.contains(&category) {
        return error(format!("category must be one of {}", CATEGORIES.join("|")));
    }
    let Some(generalizable) = raw.get("generalizable").and_then(Value::as_bool) else {
        return error("generalizable must be boolean");
    };
    let confidence = raw.get("confidence").and_then(Value::as_str).unwrap_or("");
    if !["low", "medium", "high"].contains(&confidence) {
        return error("confidence must be low|medium|high");
    }
    let Some(needs_verification) = raw.get("needsVerification").and_then(Value::as_bool) else {
        return error("needsVerification must be boolean");
    };
    let Some(refs) = raw.get("evidenceRefs").and_then(Value::as_array) else {
        return error("evidenceRefs must be a non-empty array");
    };
    if refs.is_empty() {
        return error("evidenceRefs must be a non-empty array");
    }
    let allowed: HashSet<&str> = input
        .get("allowedRefs")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut observed = HashSet::new();
    let mut unique = Vec::new();
    for reference in refs {
        let name = reference.as_str();
        if name.is_none_or(|r| !allowed.contains(r)) {
            let display = name.map(str::to_owned).unwrap_or_else(|| match reference {
                Value::Null => "null".into(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => n.to_string(),
                Value::Object(_) => "[object Object]".into(),
                Value::Array(_) => "".into(),
                _ => "".into(),
            });
            return error(format!(
                "evidenceRef \"{display}\" does not resolve to supplied evidence"
            ));
        }
        let name = name.unwrap_or("");
        if observed.insert(name.to_owned()) {
            unique.push(name);
        }
    }
    let duplicate = match raw.get("duplicateOf") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(value)) if !value.is_empty() => json!(value),
        Some(Value::String(_)) => Value::Null,
        _ => return error("duplicateOf must be null or a string"),
    };
    verdict(json!({"ok":true,"lesson":{
        "title":title,"text":text,"category":category,"generalizable":generalizable,
        "confidence":confidence,"needsVerification":needs_verification,
        "evidenceRefs":unique,"duplicateOf":duplicate
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_policy_rejects_runtime_state() {
        let result = classify(
            &json!({"files":["src/main.rs","docs/note.md","data/selflearn/pending/a.rs","C:\\work\\build\\a.rs"],"platform":"win32"}),
        );
        assert_eq!(result["material"], json!(["src/main.rs"]));
        assert_eq!(result["skipped"].as_array().map(Vec::len), Some(3));
        assert_eq!(result["docsOnly"], false);
    }
    #[test]
    fn windows_root_separator_preserves_drive_letter() {
        let result = doc_roots(&json!({"raw":" C:\\src ; D:\\docs ; ","platform":"win32"}));
        assert_eq!(result["roots"], json!(["C:\\src", "D:\\docs"]));
    }
    #[test]
    fn lesson_evidence_cannot_be_invented() {
        let raw = json!({"schema":"selflearn.lesson.v1","title":"Example","lesson":"Supported evidence",
            "category":"bugfix","generalizable":true,"confidence":"high",
            "needsVerification":false,"evidenceRefs":["not-supplied.rs"],"duplicateOf":null});
        let response = validate_lesson(&json!({"raw":raw,"allowedRefs":["source.rs"]}));
        assert_eq!(response["value"]["ok"], false);
        assert_eq!(
            response["value"]["error"],
            "evidenceRef \"not-supplied.rs\" does not resolve to supplied evidence"
        );
    }
    #[test]
    fn candidate_id_ignores_duplicate_and_order() {
        let one = candidate_id(&json!({"session":"run","files":["x.rs","a.rs","x.rs"]}));
        let two = candidate_id(&json!({"session":"run","files":["a.rs","x.rs"]}));
        assert_eq!(one, two);
        assert_eq!(one["id"].as_str().map(str::len), Some(8));
    }
}
