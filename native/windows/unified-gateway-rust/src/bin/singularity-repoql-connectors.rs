//! Read-only native projection of the RepoQL connector inventory.
//!
//! The verified RepoQL CLI remains the only source of truth. This binary
//! accepts one bounded JSON request on stdin and emits only the dashboard's
//! public allowlisted fields. It performs no CLI calls, network requests,
//! credential reads, installation, or state mutation.
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_INPUT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CONNECTORS: usize = 200;

fn text(value: Option<&Value>, limit: usize) -> String {
    match value.and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s.chars().take(limit).collect(),
        _ => String::new(),
    }
}

fn token(value: Option<&Value>, limit: usize) -> String {
    text(value, limit)
        .to_lowercase()
        .chars()
        .filter(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, ' ' | '_' | '-')
        })
        .collect::<String>()
        .trim()
        .to_owned()
}

fn count(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn valid_scheme(scheme: &str) -> bool {
    let bytes = scheme.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(*c, b'+' | b'.' | b'-')
        })
}

fn valid_root(root: &str) -> bool {
    let Some((scheme, path)) = root.split_once("://") else {
        return false;
    };
    valid_scheme(scheme)
        && path
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '.' | '/' | '~' | '-'))
}

fn stamp(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    // Python fromisoformat accepts timezone-free timestamps and treats them
    // as UTC in the legacy connector inventory projection.
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(value, format) {
            return Some(parsed.and_utc());
        }
    }
    None
}

fn legacy(entry: &Value) -> Option<Value> {
    let name = {
        let one = text(entry.get("name"), 120);
        if one.is_empty() {
            text(entry.get("display_name"), 120)
        } else {
            one
        }
    };
    if name.is_empty() {
        return None;
    }
    let ident = {
        let one = text(entry.get("id"), 120);
        if one.is_empty() {
            text(entry.get("scheme"), 64)
        } else {
            one
        }
    };
    let state = {
        let one = token(entry.get("status"), 32);
        let two = if one.is_empty() {
            token(entry.get("state"), 32)
        } else {
            one
        };
        if two.is_empty() {
            "installed".to_owned()
        } else {
            two
        }
    };
    Some(json!({
        "id": if ident.is_empty() { name.clone() } else { ident },
        "name": name, "status": state, "active": false,
        "registry_state": state, "import_state": "", "freshness": "missing",
        "freshAsOf": "", "sweepIntervalSeconds": null, "files": null,
        "bytes": null, "version": text(entry.get("version"), 72),
        "description": text(entry.get("description"), 240)
    }))
}

fn connector(entry: &Value, imports: &[Value], now: DateTime<Utc>) -> Option<Value> {
    if !entry.is_object() {
        return None;
    }
    let scheme = text(entry.get("scheme"), 64).to_lowercase();
    if !valid_scheme(&scheme) {
        return legacy(entry);
    }
    let registry = {
        let state = token(entry.get("state"), 32);
        if state.is_empty() {
            "unknown".to_owned()
        } else {
            state
        }
    };
    let title = {
        let value = text(entry.get("title"), 120);
        if value.is_empty() {
            scheme.clone()
        } else {
            value
        }
    };
    let matches: Vec<&Value> = imports
        .iter()
        .filter(|import| {
            if !import.is_object() || token(import.get("kind"), 32) != "connector" {
                return false;
            }
            let root = text(import.get("root"), 200);
            let named = token(import.get("scheme"), 64);
            named == scheme || root.to_lowercase().starts_with(&format!("{scheme}://"))
        })
        .collect();
    let mut ambiguous = matches.len() > 1;
    let mut row = if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    };
    if let Some(import) = row {
        let named = token(import.get("scheme"), 64);
        let root = text(import.get("root"), 200);
        let from_root = root
            .split_once("://")
            .map(|(prefix, _)| prefix.to_lowercase())
            .unwrap_or_default();
        if (!named.is_empty() && named != scheme) || (!from_root.is_empty() && from_root != scheme)
        {
            ambiguous = true;
            row = None;
        }
    }
    let import_state = if ambiguous {
        "ambiguous".to_owned()
    } else {
        row.map_or(String::new(), |i| token(i.get("state"), 32))
    };
    let raw_stamp = row.map_or(String::new(), |i| text(i.get("freshAsOf"), 40));
    let parsed_stamp = row.and_then(|_| stamp(&raw_stamp));
    let sweep = row.and_then(|i| count(i.get("sweepIntervalSeconds")));
    let files = row.and_then(|i| count(i.get("files")));
    let bytes = row.and_then(|i| count(i.get("bytes")));
    let root = row.map_or(String::new(), |i| text(i.get("root"), 200));

    let freshness = if ambiguous {
        "ambiguous"
    } else if row.is_none() {
        "missing"
    } else if let Some(when) = parsed_stamp.as_ref() {
        let age = now
            .signed_duration_since(when.to_owned())
            .num_microseconds()
            .unwrap_or(i64::MAX) as f64
            / 1_000_000.0;
        let stale_after =
            300_u64.max(3_u64.saturating_mul(sweep.filter(|n| *n > 0).unwrap_or(900)));
        if age < -120.0 {
            "future"
        } else if age > stale_after as f64 {
            "stale"
        } else {
            "fresh"
        }
    } else {
        "unknown"
    };

    let status = if registry != "installed" {
        registry.as_str()
    } else if ambiguous {
        "ambiguous"
    } else if row.is_none() {
        "installed"
    } else if import_state != "current" {
        if ["failed", "error"].contains(&import_state.as_str()) {
            "failed"
        } else if ["waiting", "queued", "pending", "partial", "stalled"]
            .contains(&import_state.as_str())
        {
            "waiting"
        } else if import_state.is_empty() {
            "installed"
        } else {
            import_state.as_str()
        }
    } else if freshness == "fresh" {
        "active"
    } else if freshness == "stale" {
        "stale"
    } else if freshness == "future" {
        "clock_skew"
    } else {
        "current"
    };

    Some(json!({
        "id": scheme, "name": title, "status": status,
        "active": status == "active", "registry_state": registry,
        "import_state": import_state, "freshness": freshness,
        "freshAsOf": if parsed_stamp.is_some() { raw_stamp } else { String::new() },
        "sweepIntervalSeconds": sweep, "files": files, "bytes": bytes,
        "root": if valid_root(&root) { root } else { String::new() },
        "version": text(entry.get("version"), 72), "description": ""
    }))
}

fn inventory(payload: &Value, now: DateTime<Utc>) -> Option<Value> {
    let empty: &[Value] = &[];
    let (entries, imports, schema): (&[Value], &[Value], String) = match payload {
        Value::Array(items) => (items, empty, String::new()),
        Value::Object(_) => {
            let schema = text(payload.get("schema"), 80);
            if !schema.is_empty() && !schema.starts_with("repoql.imports.status") {
                return None;
            }
            let entries = payload
                .get("connectors")
                .filter(|v| !v.is_null())
                .or_else(|| {
                    ["installed", "items", "results"]
                        .iter()
                        .find_map(|key| payload.get(key).filter(|v| v.is_array()))
                })?
                .as_array()?;
            let imports = payload
                .get("imports")
                .and_then(Value::as_array)
                .map_or(empty, Vec::as_slice);
            (entries, imports, schema)
        }
        _ => return None,
    };
    let selected = entries.iter().take(MAX_CONNECTORS);
    let rows: Vec<Value> = selected
        .filter_map(|entry| connector(entry, imports, now))
        .collect();
    if !entries.is_empty() && rows.is_empty() {
        return None;
    }
    let active = rows
        .iter()
        .filter(|row| row.get("active") == Some(&Value::Bool(true)))
        .count();
    let installed = rows.len();
    Some(json!({
        "available": true, "schema": schema, "source": "RepoQL CLI",
        "connectors": rows, "active": active,
        "installed": installed, "truncated": entries.len() > MAX_CONNECTORS
    }))
}

fn process(request: &Value) -> Result<Value, &'static str> {
    let fields = request.as_object().ok_or("INVALID_REQUEST")?;
    if fields.len() != 2 || !fields.contains_key("payload") || !fields.contains_key("now") {
        return Err("INVALID_REQUEST");
    }
    let now = fields
        .get("now")
        .and_then(Value::as_str)
        .ok_or("INVALID_TIME")?;
    let now = DateTime::parse_from_rfc3339(now)
        .map_err(|_| "INVALID_TIME")?
        .with_timezone(&Utc);
    Ok(inventory(fields.get("payload").ok_or("INVALID_REQUEST")?, now).unwrap_or(Value::Null))
}

fn main() {
    let mut bytes = Vec::new();
    let reply = match io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        Ok(_) if bytes.len() as u64 <= MAX_INPUT_BYTES => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| process(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match reply {
        Ok(result) => println!("{result}"),
        Err(code) => {
            eprintln!("RepoQL connector projection rejected: {code}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-12T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    #[test]
    fn good_pair_requires_verified_unique_fresh_imports() {
        let payload = json!({"schema":"repoql.imports.status/v1", "connectors":[
            {"scheme":"kanzo","state":"installed"}], "imports":[
            {"kind":"connector","scheme":"kanzo","root":"kanzo://","state":"current", "freshAsOf":"2026-11-12T11:59:00+00:00", "sweepIntervalSeconds":60}]});
        let result = inventory(&payload, now()).unwrap();
        assert_eq!(result["active"], 1);
        assert_eq!(result["connectors"][0]["status"], "active");
        assert!(result["connectors"][0].get("privateKey").is_none());
    }
    #[test]
    fn duplicate_imports_are_ambiguous() {
        let one = json!({"kind":"connector","scheme":"kanzo","root":"kanzo://","state":"current"});
        let result = inventory(&json!({"connectors":[{"scheme":"kanzo","state":"installed"}], "imports":[one.clone(),one]}), now()).unwrap();
        assert_eq!(result["connectors"][0]["freshness"], "ambiguous");
        assert_eq!(result["active"], 0);
    }
    #[test]
    fn invalid_registry_is_not_empty_inventory() {
        assert!(inventory(&json!({"connectors":[null, 42, false]}), now()).is_none());
        assert!(inventory(&json!({"schema":"not-RepoQL","connectors":[]}), now()).is_none());
    }
}
