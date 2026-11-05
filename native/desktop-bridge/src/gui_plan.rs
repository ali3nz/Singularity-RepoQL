//! Read-only planning for native desktop GUI configuration.
//! Never writes GUI settings, never prints their current content, and never
//! handles credential values. A later Windows installer can consume an approved
//! proposal after checking the target application's actual version/config path.
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::Path;

const NAME: &str = "singularity-memory";

fn safe_local_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 4
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && !value.chars().any(|c| c.is_control())
        && !value.split('\\').any(|part| part == "..")
}

fn target_description(target: &str) -> Result<(&'static str, &'static str), &'static str> {
    match target {
        "claude-code-tab-project" => Ok(("mcpServers", "claude-desktop-code-local-session")),
        "openchamber-opencode-v1" => Ok(("mcp", "opencode-v1")),
        "openchamber-opencode-v2" => Ok(("mcp.servers", "opencode-v2")),
        _ => Err("unknown GUI target; use claude-code-tab-project, openchamber-opencode-v1, or openchamber-opencode-v2"),
    }
}

fn valid_scope(scope: &str) -> bool {
    !scope.trim().is_empty() && scope.len() <= 128 && !scope.chars().any(|c| c.is_control())
}

fn entry(target: &str, exe: &str, secrets: &str, team: &str, user: &str, agent: &str) -> Value {
    if target == "claude-code-tab-project" {
        json!({
            "command": exe,
            "args": ["serve"],
            "env": {
                "SINGULARITY_MEMORY_CONFIG": secrets,
                "SINGULARITY_MEMORY_TEAM": team,
                "SINGULARITY_MEMORY_USER": user,
                "SINGULARITY_MEMORY_AGENT": agent
            }
        })
    } else if target == "openchamber-opencode-v1" {
        json!({
            "type": "local",
            "command": [exe, "serve"],
            "enabled": true,
            "environment": {
                "SINGULARITY_MEMORY_CONFIG": secrets,
                "SINGULARITY_MEMORY_TEAM": team,
                "SINGULARITY_MEMORY_USER": user,
                "SINGULARITY_MEMORY_AGENT": agent
            }
        })
    } else {
        // OpenCode v2 defaults to connected; it uses `disabled`, not `enabled`.
        json!({
            "type": "local",
            "command": [exe, "serve"],
            "environment": {
                "SINGULARITY_MEMORY_CONFIG": secrets,
                "SINGULARITY_MEMORY_TEAM": team,
                "SINGULARITY_MEMORY_USER": user,
                "SINGULARITY_MEMORY_AGENT": agent
            }
        })
    }
}

fn found<'a>(document: &'a Value, target: &str) -> Result<Option<&'a Value>, &'static str> {
    if !document.is_object() {
        return Err("existing GUI config is not a JSON object");
    }
    let mcp = if target == "claude-code-tab-project" {
        document.get("mcpServers")
    } else {
        document.get("mcp")
    };
    let Some(mcp) = mcp else { return Ok(None); };
    if !mcp.is_object() {
        return Err("existing MCP configuration is not an object");
    }
    if target == "openchamber-opencode-v1" && mcp.get("servers").is_some() {
        return Err("existing MCP configuration appears to use v2; refusing v1 proposal");
    }
    if target == "openchamber-opencode-v2" {
        let foreign_v1 = mcp.as_object().map(|map| map.iter().any(|(key, value)| {
            key != "servers" && value.get("type").and_then(Value::as_str).is_some()
        })).unwrap_or(false);
        if foreign_v1 { return Err("existing MCP configuration appears to use v1; refusing v2 proposal"); }
    }
    let collection = if target == "openchamber-opencode-v2" {
        mcp.get("servers")
    } else { Some(mcp) };
    match collection {
        None => Ok(None),
        Some(Value::Object(map)) => Ok(map.get(NAME)),
        _ => Err("existing MCP server collection is not an object"),
    }
}

pub fn plan(target: &str, existing: &Value, exe: &str, secrets: &str, team: &str, user: &str, agent: &str) -> Result<Value, &'static str> {
    let (location, format) = target_description(target)?;
    if !safe_local_windows_path(exe) || !exe.to_ascii_lowercase().ends_with(".exe") {
        return Err("bridge executable must be an absolute local Windows .exe path");
    }
    if !safe_local_windows_path(secrets) || !secrets.to_ascii_lowercase().ends_with(".json") {
        return Err("MemoryCore config must be an absolute local Windows .json path");
    }
    if ![team, user, agent].iter().all(|scope| valid_scope(scope)) {
        return Err("team, user and agent identities must be explicitly set and each at most 128 characters");
    }
    let proposed = entry(target, exe, secrets, team, user, agent);
    let preexisting = found(existing, target)?;
    let (state, reason) = match preexisting {
        None => ("ADD", "target entry not found"),
        Some(previous) if previous == &proposed => ("UNCHANGED", "target entry matches proposal"),
        Some(_) => ("BLOCKED", "existing Singularity entry differs; no automatic replacement"),
    };
    Ok(json!({
        "target": target,
        "format": format,
        "operation": state,
        "reason": reason,
        "writesPerformed": false,
        "entryName": NAME,
        "entryPath": location,
        "entry": proposed,
        "notice": if target == "claude-code-tab-project" {
            "Project .mcp.json is one Code-tab source. Check Claude Desktop chat config and ~/.claude.json for same-name server precedence before applying."
        } else if target == "openchamber-opencode-v2" {
            "Requires confirmed OpenCode v2. Do not write v2 shape into a v1 config."
        } else {
            "Requires confirmed OpenCode v1. Do not write v1 shape into a v2 config."
        }
    }))
}

/// Read-only JSONC parsing for OpenCode configuration. Preserve the original
/// bytes on disk: strip comments only in a temporary buffer, then strip
/// commas immediately before a closing object/array. Strings are respected.
/// Invalid/malformed JSONC fails closed; this is NOT a configuration writer.
fn parse_gui_config(raw: &str) -> Result<Value, &'static str> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    let mut quoted = false;
    let mut escaped = false;
    while idx < bytes.len() {
        let current = bytes[idx];
        if quoted {
            out.push(current);
            if escaped { escaped = false; }
            else if current == b'\\' { escaped = true; }
            else if current == b'"' { quoted = false; }
            idx += 1;
            continue;
        }
        if current == b'"' { quoted = true; out.push(current); idx += 1; continue; }
        if current == b'/' && bytes.get(idx + 1) == Some(&b'/') {
            out.extend_from_slice(b"  "); idx += 2;
            while idx < bytes.len() && bytes[idx] != b'\n' && bytes[idx] != b'\r' {
                out.push(b' '); idx += 1;
            }
            continue;
        }
        if current == b'/' && bytes.get(idx + 1) == Some(&b'*') {
            out.extend_from_slice(b"  "); idx += 2;
            let mut closed = false;
            while idx < bytes.len() {
                if bytes[idx] == b'*' && bytes.get(idx + 1) == Some(&b'/') {
                    out.extend_from_slice(b"  "); idx += 2; closed = true; break;
                }
                out.push(if bytes[idx] == b'\n' || bytes[idx] == b'\r' { bytes[idx] } else { b' ' });
                idx += 1;
            }
            if !closed { return Err("unterminated JSONC block comment"); }
            continue;
        }
        out.push(current);
        idx += 1;
    }
    if quoted { return Err("unterminated JSONC string"); }
    let mut quoted = false;
    let mut escaped = false;
    for i in 0..out.len() {
        let c = out[i];
        if quoted {
            if escaped { escaped = false; }
            else if c == b'\\' { escaped = true; }
            else if c == b'"' { quoted = false; }
            continue;
        }
        if c == b'"' { quoted = true; continue; }
        if c == b',' {
            let mut j = i + 1;
            while j < out.len() && out[j].is_ascii_whitespace() { j += 1; }
            if j < out.len() && matches!(out[j], b'}' | b']') { out[i] = b' '; }
        }
    }
    serde_json::from_slice(&out).map_err(|_| "invalid JSON/JSONC GUI configuration")
}

pub fn plan_from_args(args: &[String]) -> Result<Value, &'static str> {
    // Explicit existing-config path and no writes. Missing config is treated as
    // an empty document, never silently materialized on disk.
    if args.len() != 14 || args[0] != "--target" || args[2] != "--existing"
        || args[4] != "--exe" || args[6] != "--memory-config"
        || args[8] != "--team" || args[10] != "--user" || args[12] != "--agent"
    {
        return Err("usage: plan --target TARGET --existing PATH --exe C:\\path\\bridge.exe --memory-config C:\\path\\memory.json --team TEAM --user USER --agent AGENT");
    }
    let file = Path::new(&args[3]);
    let existing = if file.exists() {
        let raw = fs::read_to_string(file).map_err(|_| "cannot read GUI configuration")?;
        parse_gui_config(&raw)?
    } else { json!({}) };
    let mut proposal = plan(&args[1], &existing, &args[5], &args[7], &args[9], &args[11], &args[13])?;
    proposal["existingFileFound"] = Value::Bool(file.exists());
    // Don't expose the existing config content, even if it contains auth tokens.
    // No automatic discovery: Windows machines may have portable app profiles,
    // multiple app installations or custom OpenCode config directories.
    Ok(proposal)
}

pub fn run_plan() -> i32 {
    let args: Vec<String> = env::args().skip(2).collect();
    match plan_from_args(&args) {
        Ok(value) => {
            println!("{value}");
            if value["operation"] == "BLOCKED" { 3 } else { 0 }
        }
        Err(reason) => {
            eprintln!("singularity desktop planning blocked: {reason}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const EXE: &str = r"C:\Users\Tester\Singularity\bin\singularity-desktop-bridge.exe";
    const CONFIG: &str = r"C:\Users\Tester\Singularity\secrets\memory.json";
    const TEAM: &str = "project-team";
    const USER: &str = "project-user";
    const AGENT: &str = "singularity";

    #[test]
    fn each_host_uses_correct_mcp_schema_without_any_writes() {
        let cases = [
            ("claude-code-tab-project", "mcpServers"),
            ("openchamber-opencode-v1", "mcp"),
            ("openchamber-opencode-v2", "mcp.servers"),
        ];
        for (target, location) in cases {
            let proposal = plan(target, &json!({}), EXE, CONFIG, TEAM, USER, AGENT).unwrap();
            assert_eq!(proposal["entryPath"], location);
            assert_eq!(proposal["operation"], "ADD");
            assert_eq!(proposal["writesPerformed"], false);
            assert_eq!(proposal["entry"]["command"].is_array(), target != "claude-code-tab-project");
            if target == "openchamber-opencode-v2" {
                assert!(proposal["entry"].get("enabled").is_none());
                assert!(proposal["entry"].get("disabled").is_none());
            }
            assert!(proposal.to_string().contains("singularity-desktop-bridge.exe"));
            assert!(!proposal.to_string().contains("gatewayKey"));
            let env = if target == "claude-code-tab-project" { &proposal["entry"]["env"] } else { &proposal["entry"]["environment"] };
            assert_eq!(env["SINGULARITY_MEMORY_TEAM"], TEAM);
            assert_eq!(env["SINGULARITY_MEMORY_USER"], USER);
            assert_eq!(env["SINGULARITY_MEMORY_AGENT"], AGENT);
        }
    }

    #[test]
    fn conflicting_own_entries_are_blocked_and_other_servers_preserved() {
        let doc = json!({"mcpServers": {"unrelated": {"command":"safe"},"singularity-memory":{"command":"other.exe"}}, "models": {"auth": "untouched"}});
        let before = doc.clone();
        let p = plan("claude-code-tab-project", &doc, EXE, CONFIG, TEAM, USER, AGENT).unwrap();
        assert_eq!(p["operation"], "BLOCKED");
        assert!(!p.to_string().contains("untouched"));
        assert_eq!(doc, before);
    }

    #[test]
    fn exact_owned_entry_is_idempotent() {
        let proposed = entry("openchamber-opencode-v2", EXE, CONFIG, TEAM, USER, AGENT);
        let existing = json!({"mcp": {"servers": {"singularity-memory": proposed, "foreign": {"type":"remote"}}}});
        let result = plan("openchamber-opencode-v2", &existing, EXE, CONFIG, TEAM, USER, AGENT).unwrap();
        assert_eq!(result["operation"], "UNCHANGED");
    }

    #[test]
    fn v1_entry_does_not_override_v2_servers() {
        let doc = json!({"mcp":{"servers":{"singularity-memory":{"command":["old"]}}}});
        assert!(plan("openchamber-opencode-v1", &doc, EXE, CONFIG, TEAM, USER, AGENT).is_err());
    }

    #[test]
    fn planner_requires_an_explicit_nonempty_scope() {
        assert!(plan("claude-code-tab-project", &json!({}), EXE, CONFIG, "", USER, AGENT).is_err());
        assert!(plan("claude-code-tab-project", &json!({}), EXE, CONFIG, TEAM, "", AGENT).is_err());
        assert!(plan("claude-code-tab-project", &json!({}), EXE, CONFIG, TEAM, USER, "\n").is_err());
    }

    #[test]
    fn refuse_network_executables_and_invalid_paths() {
        for bad in [r"\\server\share\bridge.exe", r"..\bridge.exe", r"C:\temp\..\bridge.exe", "C:\\test\\bridge.exe\n"] {
            assert!(plan("claude-code-tab-project", &json!({}), bad, CONFIG, TEAM, USER, AGENT).is_err());
        }
        assert!(plan("claude-code-tab-project", &json!({}), EXE, r"\\server\secrets\memory.json", TEAM, USER, AGENT).is_err());
    }
    #[test]
    fn jsonc_config_parses_comments_and_trailing_commas_without_changing_source() {
        let original = r#"{
            // keep this user comment
            "theme": "https://example.test/value//literal", /* keep this too */
            "mcp": {"repoql": {"type": "local", "command": ["rql", "mcp",],},},
        }"#;
        let copy = original.to_owned();
        let parsed = parse_gui_config(original).unwrap();
        assert_eq!(parsed["theme"], "https://example.test/value//literal");
        assert_eq!(parsed["mcp"]["repoql"]["type"], "local");
        assert_eq!(original, copy);
        assert!(parse_gui_config(r#"{"oops":1,/* no end"#).is_err());
        assert!(parse_gui_config(r#"{"oops": ,}"#).is_err());
    }

}
