//! Read-only MemoryCore documentation ledger evidence cross-check.
//!
//! Python owns the ledger, path resolution, hashing, authenticated memory
//! operations, and authoritative verdict. Only boolean state and positional
//! revision indexes enter this process; no content, scopes, IDs or timestamps.
use serde_json::{json, Value};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-doc-ledger-evidence/v1";
const MAX_INPUT: u64 = 32 * 1024;
const MAX_REVISIONS: usize = 256;

fn flag(value: Option<&Value>) -> Result<bool, &'static str> {
    value.and_then(Value::as_bool).ok_or("INVALID_FLAG")
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 7 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_REQUEST");
    }
    let active = flag(obj.get("active"))?;
    let hash_equal = flag(obj.get("hash_equal"))?;
    let indexed = flag(obj.get("indexed"))?;
    let verified = flag(obj.get("verified"))?;
    let chunks_complete = flag(obj.get("chunks_complete"))?;
    let revisions = obj
        .get("revisions")
        .and_then(Value::as_array)
        .ok_or("INVALID_REVISIONS")?;
    if revisions.len() > MAX_REVISIONS {
        return Err("TOO_MANY_REVISIONS");
    }
    let mut unresolved = Vec::new();
    for (index, revision) in revisions.iter().enumerate() {
        let row = revision.as_object().ok_or("INVALID_REVISION")?;
        if row.len() != 3 {
            return Err("INVALID_REVISION");
        }
        let is_active = flag(row.get("active"))?;
        let is_unresolved = flag(row.get("unresolved"))?;
        let is_newer = flag(row.get("newer"))?;
        if !is_active && is_unresolved && is_newer {
            unresolved.push(index);
        }
    }
    let verdict = if active && !hash_equal {
        "stale_hash"
    } else if !indexed || !verified {
        "not_indexed"
    } else if !chunks_complete {
        "incomplete_chunks"
    } else if !unresolved.is_empty() {
        "unresolved_revisions"
    } else {
        "verified"
    };
    Ok(json!({"ok":true, "verdict":verdict, "newer_unresolved_indices":unresolved}))
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(MAX_INPUT + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_INPUT => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| project(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            // Fixed error labels only, never echo even a malicious request.
            eprintln!("Document ledger evidence rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Value {
        json!({"schema":SCHEMA,"active":true,"hash_equal":true,"indexed":true,
               "verified":true,"chunks_complete":true,"revisions":[]})
    }
    #[test]
    fn precedence_and_unresolved_indexes() {
        let mut req = base();
        assert_eq!(project(&req).unwrap()["verdict"], "verified");
        req["revisions"] = json!([
            {"active":true,"unresolved":true,"newer":true},
            {"active":false,"unresolved":true,"newer":true},
            {"active":false,"unresolved":false,"newer":true}
        ]);
        let result = project(&req).unwrap();
        assert_eq!(result["verdict"], "unresolved_revisions");
        assert_eq!(result["newer_unresolved_indices"], json!([1]));
        req["chunks_complete"] = json!(false);
        assert_eq!(project(&req).unwrap()["verdict"], "incomplete_chunks");
        req["verified"] = json!(false);
        assert_eq!(project(&req).unwrap()["verdict"], "not_indexed");
        req["hash_equal"] = json!(false);
        assert_eq!(project(&req).unwrap()["verdict"], "stale_hash");
    }
    #[test]
    fn rejects_private_fields_and_invalid_states() {
        let mut req = base();
        req["root"] = json!("sensitive");
        assert!(project(&req).is_err());
        req = base();
        req["active"] = json!(1);
        assert!(project(&req).is_err());
        req = base();
        req["revisions"] =
            json!([{"active":true,"unresolved":false,"newer":false,"hash":"secret"}]);
        assert!(project(&req).is_err());
        req = base();
        req["revisions"] = json!(vec![
            json!({"active":false,"unresolved":false,"newer":false});
            MAX_REVISIONS + 1
        ]);
        assert!(project(&req).is_err());
    }
}
