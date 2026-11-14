//! Deterministic, side-effect-free memory conflict signals.
//!
//! Port of the existing concept-conflict-gate.mjs signals only. This module
//! never authorizes memory promotion, reads an external store, or adjudicates
//! which conflicting claim is true. The existing review gate retains that job.
use regex::Regex;
use serde_json::{json, Value};

const ANTONYMS: [(&str, &str); 12] = [
    ("required", "forbidden"),
    ("required", "optional"),
    ("never", "always"),
    ("must", "must not"),
    ("enabled", "disabled"),
    ("up", "down"),
    ("true", "false"),
    ("is", "is not"),
    ("retired", "active"),
    ("deprecated", "supported"),
    ("primary", "retired"),
    ("allowed", "rejected"),
];

/// JavaScript's lowercasing followed by /[^a-z0-9 ]/g and /\s+/g.
/// The normalized result is ASCII, so source-substring matching is stable.
fn norm(s: &str) -> String {
    let mut ascii = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == ' ' {
            ascii.push(c);
        } else {
            ascii.push(' ');
        }
    }
    ascii.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_word(text: &str, word: &str) -> bool {
    text.contains(&format!(" {word} "))
        || text.starts_with(&format!("{word} "))
        || text.ends_with(&format!(" {word}"))
}

fn stem<'a>(text: &'a str, word: &str) -> &'a str {
    text.split_once(&format!(" {word} "))
        .map_or(text, |(s, _)| s)
        .trim()
}

fn shared_subject_signal(a: &str, b: &str, x: &str, y: &str) -> Option<String> {
    let sa = stem(a, x);
    let sb = stem(b, y);
    if sa.is_empty() || sb.is_empty() || !(sa.contains(sb) || sb.contains(sa)) {
        return None;
    }
    let shorter = if sa.len() <= sb.len() { sa } else { sb };
    let last_40 = shorter
        .chars()
        .rev()
        .take(40)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Some(format!("antonym {x}/{y} on shared subject \"{last_40}\""))
}

pub fn contradiction(a: &str, b: &str) -> Option<String> {
    let a = norm(a);
    let b = norm(b);
    if a.is_empty() || b.is_empty() || a == b {
        return None;
    }
    for (x, y) in ANTONYMS {
        let ax = has_word(&a, x);
        let bx = has_word(&b, x);
        let ay = has_word(&a, y);
        let by = has_word(&b, y);
        if ax && by {
            if let Some(signal) = shared_subject_signal(&a, &b, x, y) {
                return Some(signal);
            }
        }
        if ay && bx {
            if let Some(signal) = shared_subject_signal(&a, &b, y, x) {
                return Some(signal);
            }
        }
    }
    None
}

fn numeric_skeleton(s: &str) -> (String, Vec<String>) {
    let mut skeleton = String::with_capacity(s.len());
    let mut numbers = Vec::new();
    let mut current = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            current.push(c);
        } else {
            if !current.is_empty() {
                skeleton.push('#');
                numbers.push(std::mem::take(&mut current));
            }
            skeleton.push(c);
        }
    }
    if !current.is_empty() {
        skeleton.push('#');
        numbers.push(current);
    }
    (skeleton, numbers)
}

pub fn numeric_divergence(a: &str, b: &str) -> Option<String> {
    let a = norm(a);
    let b = norm(b);
    if a.is_empty() || b.is_empty() {
        return None;
    }
    let (sa, na) = numeric_skeleton(&a);
    let (sb, nb) = numeric_skeleton(&b);
    if sa != sb || na.is_empty() || na == nb {
        return None;
    }
    Some(format!(
        "numeric divergence ({} vs {})",
        na.join("/"),
        nb.join("/")
    ))
}

/// Matches the simple capsule emitter's frontmatter, not general YAML.
/// Unknown fields are deliberately ignored, as in concept-conflict-gate.mjs.
pub fn parse_capsule(body: Option<&str>) -> Value {
    let mut out = json!({"title":null,"description":null,"category":null,
        "relevance":null,"verification":null,"ttl":null,"verifiedDate":null});
    let Some(body) = body else {
        return out;
    };
    let title_re = Regex::new(r"(?m)^#\s+(.+)$").expect("literal regex");
    if let Some(title) = title_re.captures(body).and_then(|m| m.get(1)) {
        out["title"] = json!(title.as_str().trim());
    }
    let fm_re = Regex::new(r"(?s)^---\n(.*?)\n---").expect("literal regex");
    let Some(fm) = fm_re.captures(body).and_then(|m| m.get(1)) else {
        return out;
    };
    let key_re = Regex::new(r"^(\w[\w-]*):\s*(.*)$").expect("literal regex");
    let mut in_verified = false;
    for line in fm.as_str().split('\n') {
        if line.ends_with('\r') {
            continue;
        } // JS line matcher rejects a CR suffix.
        let Some(kv) = key_re.captures(line) else {
            continue;
        };
        let key = kv.get(1).map(|m| m.as_str()).unwrap_or("");
        let raw = kv.get(2).map(|m| m.as_str()).unwrap_or("");
        let mut value = raw.trim();
        if matches!(value.chars().next(), Some('\'' | '"')) {
            value = &value[1..];
        }
        if matches!(value.chars().last(), Some('\'' | '"')) {
            value = &value[..value.len() - 1];
        }
        if key == "verified" {
            in_verified = true;
            continue;
        }
        if in_verified && key == "date" {
            out["verifiedDate"] = json!(value);
            in_verified = false;
            continue;
        }
        in_verified = false;
        match key {
            "description" | "category" | "relevance" | "verification" => out[key] = json!(value),
            "ttl" => {
                if let Ok(v) = value.parse::<f64>() {
                    if v.is_finite() && v != 0.0 {
                        out["ttl"] = json!(v);
                    }
                }
            }
            _ => (),
        }
    }
    out
}

pub fn extract_invariant(body: &str) -> String {
    // The JS expression uses a positive lookahead to stop at the next bold
    // section. Rust's regular expression engine doesn't support lookahead;
    // splitting after the opening token has the same result here.
    let start_re = Regex::new(r"\*\*Invariant\*\*\s*\n").expect("literal regex");
    let Some(open) = start_re.find(body) else {
        return String::new();
    };
    let remaining = &body[open.end()..];
    remaining
        .split_once("\n**")
        .map_or(remaining, |(head, _)| head)
        .trim()
        .to_string()
}

pub fn evaluate(command: &str, input: &Value) -> Value {
    match command {
        "contradiction-signal" => json!({"ok":true,"signal":contradiction(
            input.get("claimA").and_then(Value::as_str).unwrap_or(""),
            input.get("claimB").and_then(Value::as_str).unwrap_or(""))}),
        "numeric-divergence" => json!({"ok":true,"signal":numeric_divergence(
            input.get("claimA").and_then(Value::as_str).unwrap_or(""),
            input.get("claimB").and_then(Value::as_str).unwrap_or(""))}),
        "parse-capsule" => {
            json!({"ok":true,"value":parse_capsule(input.get("body").and_then(Value::as_str))})
        }
        "extract-invariant" => {
            json!({"ok":true,"value":extract_invariant(input.get("body").and_then(Value::as_str).unwrap_or(""))})
        }
        _ => json!({"ok":false,"code":"UNKNOWN_COMMAND"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signal_cases() {
        assert_eq!(
            contradiction("policy required value", "policy forbidden value"),
            Some("antonym required/forbidden on shared subject \"policy\"".to_string())
        );
        assert_eq!(contradiction("same claim", "same claim"), None);
        assert_eq!(
            numeric_divergence("window is 14 days", "window is 30 days"),
            Some("numeric divergence (14 vs 30)".into())
        );
        assert_eq!(numeric_divergence("14 days", "14 weeks"), None);
    }
    #[test]
    fn capsule_cases() {
        assert_eq!(
            extract_invariant("**Invariant**\nMemory is permanent\n**Other**\nTail"),
            "Memory is permanent"
        );
        let parsed = parse_capsule(Some(
            "---\ncategory: rule\nttl: 14\nverified:\n  date: 2026-11-12\n---\n# Test",
        ));
        assert_eq!(parsed["category"], "rule");
        assert_eq!(parsed["ttl"].as_f64(), Some(14.0));
        assert_eq!(parsed["title"], "Test");
    }
}
