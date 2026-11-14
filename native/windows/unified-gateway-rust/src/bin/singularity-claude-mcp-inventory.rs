//! Read-only Claude Code MCP registration label projection.
//!
//! Python validates native Windows ownership and reads local MCP settings.
//! Only a bounded list of registration names is forwarded to this CLI. Server
//! commands, auth, connection URLs, env variables and config paths stay private.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-claude-mcp-inventory/v1";
const MAX_BYTES: u64 = 128 * 1024;
const MAX_NAMES: usize = 1024;

fn entry(
    requirement: &str,
    alias: Option<&str>,
    plugin: bool,
    mcp_server: bool,
    registered: &BTreeMap<String, String>,
    names: &[String],
) -> Value {
    let exact = alias.and_then(|s| registered.get(s)).map(String::as_str);
    let wrappers: Vec<String> = if let Some(alias) = alias {
        let mut unique = BTreeSet::new();
        for name in names {
            let lowered = name.to_lowercase();
            if lowered != alias && lowered.contains(alias) {
                unique.insert(name.clone());
            }
        }
        unique.into_iter().take(3).collect()
    } else {
        Vec::new()
    };
    let (status, reason) = if exact.is_some() {
        ("configured", Value::Null)
    } else if !mcp_server {
        (
            "not_verified",
            json!("connector_registration_not_inspected"),
        )
    } else if !wrappers.is_empty() {
        ("not_verified", json!("unrecognised_wrapper_name"))
    } else {
        ("missing", json!("no_matching_registration"))
    };
    let mut result = json!({
        "requirement": requirement,
        "status": status,
        "servers": exact.map(|name| vec![name]).unwrap_or_default(),
        "pluginAlternative": plugin,
        "reason": reason,
    });
    if !wrappers.is_empty() {
        result["unknownWrappers"] = json!(wrappers);
    }
    result
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let object = request.as_object().ok_or("INVALID_REQUEST")?;
    if object.len() != 2
        || object.get("schema").and_then(Value::as_str) != Some(SCHEMA)
        || !object.contains_key("names")
    {
        return Err("INVALID_REQUEST");
    }
    let rows = request["names"].as_array().ok_or("INVALID_NAMES")?;
    if rows.len() > MAX_NAMES {
        return Err("TOO_MANY_NAMES");
    }
    let mut names = Vec::with_capacity(rows.len());
    let mut registered = BTreeMap::new();
    for raw in rows {
        let name = raw.as_str().ok_or("INVALID_NAME")?;
        if name.chars().count() > 100 || name.chars().any(|c| c.is_control()) {
            return Err("INVALID_NAME");
        }
        registered
            .entry(name.to_lowercase())
            .or_insert_with(|| name.to_owned());
        names.push(name.to_owned());
    }
    let mut required = serde_json::Map::new();
    for (key, requirement, alias, plugin, mcp_server) in [
        (
            "repoql",
            "official_plugin_or_mcp",
            Some("repoql"),
            true,
            true,
        ),
        ("kanzo", "project_mcp", Some("kanzo"), false, true),
        (
            "memorycore",
            "repoql_memorycore_connector",
            None,
            false,
            false,
        ),
        (
            "openmausbot",
            "local_paired_mcp",
            Some("openmausbot"),
            false,
            true,
        ),
    ] {
        required.insert(
            key.to_owned(),
            entry(requirement, alias, plugin, mcp_server, &registered, &names),
        );
    }
    let mut missing = Vec::new();
    let mut unknown = Vec::new();
    for key in ["repoql", "kanzo", "memorycore", "openmausbot"] {
        match required[key]["status"].as_str() {
            Some("missing") => missing.push(key),
            Some("not_verified") => unknown.push(key),
            _ => {}
        }
    }
    Ok(json!({
        "required": required,
        "requiredMissing": missing,
        "requiredNotVerified": unknown,
        "verification": "configuration_only_no_live_tool_calls",
        "liveHealthClaimed": false,
    }))
}

fn main() {
    let mut input = Vec::new();
    let result = match io::stdin().take(MAX_BYTES + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_BYTES => serde_json::from_slice::<Value>(&input)
            .map_err(|_| "INVALID_JSON")
            .and_then(|value| project(&value)),
        _ => Err("REQUEST_TOO_LARGE"),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Claude MCP inventory projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_registration_does_not_imply_live_health() {
        let got =
            project(&json!({"schema":SCHEMA,"names":["RepoQL","kanzo","openmausbot"]})).unwrap();
        assert_eq!(got["required"]["repoql"]["status"], "configured");
        assert_eq!(got["required"]["memorycore"]["status"], "not_verified");
        assert_eq!(got["liveHealthClaimed"], false);
    }
    #[test]
    fn wrapper_is_unknown_not_registered() {
        let got =
            project(&json!({"schema":SCHEMA,"names":["not-memorycore", "repoql-test"]})).unwrap();
        assert_eq!(got["required"]["repoql"]["status"], "not_verified");
        assert_eq!(
            got["required"]["repoql"]["unknownWrappers"],
            json!(["repoql-test"])
        );
        assert_eq!(got["required"]["kanzo"]["status"], "missing");
    }
    #[test]
    fn rejects_sensitive_or_unbounded_input() {
        let mut request = json!({"schema":SCHEMA,"names":["kanzo"]});
        request["credentials"] = json!("PRIVATE");
        assert!(project(&request).is_err());
        assert!(project(&json!({"schema":SCHEMA,"names":[{"env":"PRIVATE"}]})).is_err());
        assert!(project(&json!({"schema":SCHEMA,"names":["name\\ntoken"]})).is_ok());
        assert!(project(&json!({"schema":SCHEMA,"names":["name\ntoken"]})).is_err());
    }
}
