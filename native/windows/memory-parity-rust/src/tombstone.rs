//! Read-only exact-value tombstone matching from memory-tombstone.mjs.
//! Deliberately DOES NOT port tombstoneForSubject(): that existing subject-only
//! retrieval check is overbroad and is pending correction in the V2 review.
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn canonical_text(text: &str) -> String {
    let mut out = String::new();
    let mut last_space = true;
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ".:/+-".contains(ch) {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    let trimmed = out
        .trim_end_matches(' ')
        .trim_end_matches(|c| ".:/+-".contains(c));
    trimmed.to_owned()
}

pub fn rejection_digest(subject: &str, field: &str, claim: &str) -> String {
    let material = format!(
        "{}\0{}\0{}",
        canonical_text(subject),
        canonical_text(field),
        canonical_text(claim)
    );
    let digest = Sha256::digest(material.as_bytes());
    format!("{digest:x}")[..16].to_owned()
}

pub fn scope_applies(pattern: Option<&str>, candidate: Option<&str>) -> bool {
    let pattern = pattern.unwrap_or("*").trim();
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    let Some(candidate) = candidate.filter(|v| !v.trim().is_empty()) else {
        return true;
    };
    let mut pattern_regex = String::from("^");
    let mut it = pattern.chars().peekable();
    while let Some(ch) = it.next() {
        if ch == '*' {
            if it.peek() == Some(&'*') {
                it.next();
                pattern_regex.push_str(".*");
            } else {
                pattern_regex.push_str("[^/]*");
            }
        } else {
            pattern_regex.push_str(&regex::escape(&ch.to_string()));
        }
    }
    pattern_regex.push('$');
    Regex::new(&pattern_regex)
        .map(|re| re.is_match(candidate.trim()))
        .unwrap_or(false)
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn matching_rejection_index(
    subject: &str,
    field_name: &str,
    claim: &str,
    scope: Option<&str>,
    tombstones: &[Value],
) -> Option<usize> {
    let digest = rejection_digest(subject, field_name, claim);
    for (index, tomb) in tombstones.iter().enumerate() {
        if tomb
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            != "active"
        {
            continue;
        }
        if canonical_text(field(tomb, "subject")) != canonical_text(subject) {
            continue;
        }
        if canonical_text(field(tomb, "field")) != canonical_text(field_name) {
            continue;
        }
        if !scope_applies(tomb.get("scope").and_then(Value::as_str), scope) {
            continue;
        }
        let digest_on_disk = field(tomb, "valueDigest");
        if !digest_on_disk.is_empty() && digest_on_disk != digest {
            continue;
        }
        if canonical_text(field(tomb, "rejectedClaim")) != canonical_text(claim) {
            continue;
        }
        return Some(index);
    }
    None
}

pub fn rejected_claim_index(
    claim: &str,
    scope: Option<&str>,
    tombstones: &[Value],
) -> Option<usize> {
    let value = canonical_text(claim);
    if value.is_empty() {
        return None;
    }
    tombstones.iter().position(|t| {
        (field(t, "status").is_empty() || field(t, "status") == "active")
            && scope_applies(t.get("scope").and_then(Value::as_str), scope)
            && canonical_text(field(t, "rejectedClaim")) == value
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a_rejected_old_value_does_not_suppress_a_corrected_claim() {
        let records = vec![json!({
            "status":"active", "subject":"Renewal", "field":"period",
            "rejectedClaim":"30 days", "scope":"concept:///knowledge/**"
        })];
        let scope = Some("concept:///knowledge/Renewal.md");
        assert_eq!(
            matching_rejection_index("Renewal", "period", "30 days", scope, &records),
            Some(0)
        );
        assert_eq!(
            matching_rejection_index("Renewal", "period", "14 days", scope, &records),
            None
        );
        assert_eq!(rejected_claim_index("14 days", scope, &records), None);
    }
    #[test]
    fn scope_and_canonicalization_match_the_source_contract() {
        assert!(scope_applies(
            Some("concept:///knowledge/**"),
            Some("concept:///knowledge/Renewal.md")
        ));
        assert!(!scope_applies(
            Some("concept:///other/**"),
            Some("concept:///knowledge/Renewal.md")
        ));
        assert_eq!(
            canonical_text("  Window IS 30 days.  "),
            "window is 30 days"
        );
        assert_ne!(
            rejection_digest("S", "F", "30 days"),
            rejection_digest("S", "F", "14 days")
        );
    }
}
