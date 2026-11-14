//! Windows memory ledger cutover preflight, read only.
//!
//! Python exclusively opens the source files, validates path ownership, hashes
//! the documents and reads the ledger. This process receives only booleans and
//! returns ordinal failure reasons; no content, paths or identifiers cross it.
//! A passing report is NOT Windows runtime, backup, rollback or release approval.
use serde_json::{json, Value};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-memory-ledger-upgrade/v1";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_DOCS: usize = 2048;

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 2 || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("INVALID_SCHEMA");
    }
    let docs = obj
        .get("documents")
        .and_then(Value::as_array)
        .ok_or("INVALID_DOCUMENTS")?;
    if docs.len() > MAX_DOCS {
        return Err("DOCUMENT_LIMIT");
    }
    let predicates: [(&str, &str); 7] = [
        ("root_authorized", "unauthorized_root"),
        ("source_exists", "missing_source"),
        ("active", "missing_active_revision"),
        ("hash_equal", "stale_source"),
        ("indexed", "not_indexed"),
        ("verified", "not_verified"),
        ("chunks_complete", "incomplete_chunks"),
    ];
    let mut failures = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        let row = doc.as_object().ok_or("INVALID_DOCUMENT")?;
        if row.len() != 8 {
            return Err("INVALID_FIELDS");
        }
        let mut reason = None;
        for (name, code) in predicates {
            let b = row
                .get(name)
                .and_then(Value::as_bool)
                .ok_or("INVALID_FLAG")?;
            if !b && reason.is_none() {
                reason = Some(code);
            }
        }
        let newer = row
            .get("newer_unresolved")
            .and_then(Value::as_bool)
            .ok_or("INVALID_FLAG")?;
        if newer && reason.is_none() {
            reason = Some("unresolved_newer_revision");
        }
        if let Some(code) = reason {
            failures.push(json!({"index":index,"reason":code}));
        }
    }
    Ok(json!({"schema":SCHEMA, "checked":docs.len(),
              "ready": !docs.is_empty() && failures.is_empty(), "failures":failures}))
}

fn main() {
    let mut bytes = Vec::new();
    let report = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "INVALID_JSON")
            .and_then(|v| project(&v)),
        _ => Err("INPUT_LIMIT"),
    };
    match report {
        Ok(value) => {
            println!("{value}");
            if value["ready"] != true {
                std::process::exit(2);
            }
        }
        Err(code) => {
            eprintln!("Memory ledger audit rejected: {code}");
            std::process::exit(3);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn good() -> Value {
        json!({"root_authorized":true,"source_exists":true,"active":true,
               "hash_equal":true,"indexed":true,"verified":true,
               "chunks_complete":true,"newer_unresolved":false})
    }
    #[test]
    fn rejects_empty_ledger_as_upgrade_proof() {
        assert_eq!(
            project(&json!({"schema":SCHEMA,"documents":[]})).unwrap()["ready"],
            false
        );
    }
    #[test]
    fn preserves_first_failure_and_revision_order() {
        let mut second = good();
        second["hash_equal"] = json!(false);
        second["newer_unresolved"] = json!(true);
        let report = project(&json!({"schema":SCHEMA,"documents":[good(), second]})).unwrap();
        assert_eq!(
            report["failures"],
            json!([{"index":1,"reason":"stale_source"}])
        );
        assert_eq!(report["ready"], false);
    }
    #[test]
    fn strict_schema_cannot_receive_private_fields() {
        let mut secret = good();
        secret["path"] = json!("secret.md");
        assert!(project(&json!({"schema":SCHEMA,"documents":[secret]})).is_err());
        assert!(project(&json!({"schema":SCHEMA,"documents":["secret"]})).is_err());
    }
}
