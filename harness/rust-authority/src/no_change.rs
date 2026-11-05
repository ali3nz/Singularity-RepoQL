//! Deterministic accepted-evidence reuse helpers from kit/lib/no-change.mjs.
//! The JS module's timestamped no-change record and filesystem cache are not ported here.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// JS uses ===; two separately supplied object/array properties do not share
// identity through the JSON compatibility boundary even if contents match.
fn js_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}

pub fn can_reuse(record: &Value) -> Value {
    let same = [
        ("priorEvidenceHash", "currentEvidenceHash"),
        ("priorSourceRevision", "currentSourceRevision"),
        ("priorConfigRevision", "currentConfigRevision"),
        ("priorCriterion", "currentCriterion"),
    ]
    .iter()
    .all(|(old, new)| js_strict_equal(record.get(old), record.get(new)));
    let why = if same {
        "evidence hash, source revision, config revision, and criterion all unchanged — accepted evidence reused (§19.5)"
    } else {
        "one or more of evidence/source/config/criterion changed — fresh validation required"
    };
    json!({"reusable":same,"why":why})
}

pub fn hash_text(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    format!("{hash:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn any_revision_difference_invalidates_reuse() {
        let a = json!({"priorEvidenceHash":"1","currentEvidenceHash":"1",
        "priorSourceRevision":"2","currentSourceRevision":"2",
        "priorConfigRevision":"3","currentConfigRevision":"4",
        "priorCriterion":"5","currentCriterion":"5"});
        assert_eq!(can_reuse(&a)["reusable"], false);
    }
}
