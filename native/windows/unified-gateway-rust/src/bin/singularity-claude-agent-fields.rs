//! Read-only Claude Code agent frontmatter field validation.
//!
//! Python continues to own file reads, original validation, edit approvals,
//! revision checks, backups and saves. Only the six already validated metadata
//! strings enter this CLI, never the agent instruction body or disk paths.
use serde_json::{json, Value};
use std::io::{self, Read};

const SCHEMA: &str = "singularity-claude-agent-fields/v1";
const MAX_BYTES: u64 = 128 * 1024;
const FIELDS: [&str; 6] = [
    "name",
    "description",
    "model",
    "effort",
    "tools",
    "permissionMode",
];

fn model_valid(model: &str) -> bool {
    let mut chars = model.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && model.len() <= 80
        && chars.all(|ch| ch.is_ascii_alphanumeric() || "._:-".contains(ch))
}

fn word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn contains_tool(tools: &str, needle: &str) -> bool {
    tools.match_indices(needle).any(|(index, _)| {
        let before = tools[..index].chars().next_back();
        let after = tools[index + needle.len()..].chars().next();
        !before.is_some_and(word_char) && !after.is_some_and(word_char)
    })
}

fn project(request: &Value) -> Result<Value, &'static str> {
    let obj = request.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != 3
        || obj.get("schema").and_then(Value::as_str) != Some(SCHEMA)
        || !obj.contains_key("owner_name")
        || !obj.contains_key("metadata")
    {
        return Err("INVALID_REQUEST");
    }
    let owner = request["owner_name"].as_str().ok_or("INVALID_OWNER")?;
    let fields = request["metadata"].as_object().ok_or("INVALID_METADATA")?;
    if fields.len() != FIELDS.len() || FIELDS.iter().any(|key| !fields.contains_key(*key)) {
        return Err("INVALID_METADATA");
    }
    let mut data = serde_json::Map::new();
    for key in FIELDS {
        let value = fields[key].as_str().ok_or("INVALID_FIELD")?;
        if value.len() > 65_536 {
            return Err("FIELD_TOO_LARGE");
        }
        data.insert(key.to_owned(), json!(value));
    }
    let get = |key: &str| data[key].as_str().unwrap_or("");
    if get("name") != owner || get("description").is_empty() {
        return Err("INVALID_AGENT_NAME");
    }
    let permission = get("permissionMode");
    if !permission.is_empty()
        && !["default", "plan", "acceptEdits", "dontAsk"].contains(&permission)
    {
        return Err("UNSAFE_PERMISSION_MODE");
    }
    let effort = get("effort");
    if !effort.is_empty() && !["low", "medium", "high", "max"].contains(&effort) {
        return Err("INVALID_EFFORT");
    }
    let model = get("model");
    if !model.is_empty() && !model_valid(model) {
        return Err("INVALID_MODEL");
    }
    if owner == "singularity-code-reviewer"
        && ["Edit", "Write", "Bash"]
            .iter()
            .any(|needle| contains_tool(get("tools"), needle))
    {
        return Err("REVIEWER_NOT_READ_ONLY");
    }
    Ok(json!({"metadata":data}))
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
            eprintln!("Claude agent field projection rejected: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(fields: Value) -> Value {
        json!({"schema":SCHEMA,"owner_name":"singularity-code-reviewer","metadata":fields})
    }
    fn safe() -> Value {
        json!({"name":"singularity-code-reviewer","description":"Read only review",
               "model":"sonnet","effort":"high","tools":"Read, Grep, Glob",
               "permissionMode":"plan"})
    }
    #[test]
    fn accepts_valid_read_only_agent_fields() {
        let got = project(&req(safe())).unwrap();
        assert_eq!(got["metadata"]["model"], "sonnet");
        assert_eq!(got["metadata"]["permissionMode"], "plan");
    }
    #[test]
    fn refuses_escalation_and_private_metadata() {
        let mut p = safe();
        p["tools"] = json!("Read, Bash");
        assert!(project(&req(p)).is_err());
        let mut p = safe();
        p["permissionMode"] = json!("bypassPermissions");
        assert!(project(&req(p)).is_err());
        let mut p = safe();
        p["api_key"] = json!("PRIVATE");
        assert!(project(&req(p)).is_err());
        let mut p = safe();
        p["model"] = json!("sonnet; rm -rf");
        assert!(project(&req(p)).is_err());
    }
}
