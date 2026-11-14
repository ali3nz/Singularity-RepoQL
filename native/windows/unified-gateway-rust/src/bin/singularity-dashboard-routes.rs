//! Public route keys only. No HTTP, credentials, upstream or side effects.
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};

const SCHEMA: &str = "singularity-dashboard-routes/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: String,
    read: bool,
    key: String,
}

fn classify(read: bool, key: &str) -> Option<&'static str> {
    let route = if read {
        match key {
            "/api/features" => "read_features",
            "/api/claude/agents" => "read_claude_agents",
            "/api/claude/agents/detail" => "read_claude_agents_detail",
            "/api/claude/policy" => "read_claude_policy",
            "/api/claude/mcps" => "read_claude_mcps",
            "/api/openmausbot/overview" => "read_openmausbot_overview",
            "/api/openmausbot/models" => "read_openmausbot_models",
            "/api/openmausbot/ops" => "read_openmausbot_ops",
            "/api/native/windows/readiness" => "read_native_windows_readiness",
            "/api/harness/office" => "read_harness_office",
            "/api/repos/usage" => "read_repos_usage",
            "/api/freebuff/allowance" => "read_freebuff_allowance",
            "/api/harness" => "read_harness",
            "/api/openchamber/telemetry" => "read_openchamber_telemetry",
            "/api/agentchat/avatars" => "read_agentchat_avatars",
            "/api/agentchat/presence" => "read_agentchat_presence",
            "/api/agentchat/feed" => "read_agentchat_feed",
            "/api/graph/annotations" => "read_graph_annotations",
            "/api/unified/" => "read_unified",
            "/api/health" => "read_health",
            "/api/overview" => "read_overview",
            "/api/status" => "read_status",
            "/api/indexing" => "read_indexing",
            "/api/files" => "read_files",
            "/api/repos" => "read_repos",
            "/api/repos/detail" => "read_repos_detail",
            "/api/knowledge" => "read_knowledge",
            "/api/knowledge/item" => "read_knowledge_item",
            "/api/hub-doc-rows" => "read_hub_doc_rows",
            "/api/memory-docs" => "read_memory_docs",
            "/api/links" => "read_links",
            "/api/links/graph" => "read_links_graph",
            "/api/connectors" => "read_connectors",
            "/api/errors" => "read_errors",
            "/api/excluded" => "read_excluded",
            "/api/embed/panels" => "read_embed_panels",
            "/api/cpu" => "read_cpu",
            "/api/activity" => "read_activity",
            _ => return None,
        }
    } else {
        match key {
            "/api/claude/agents/save" => "write_claude_agents_save",
            "/api/openmausbot/bots/model" => "write_openmausbot_bots_model",
            "/api/claude/agents/restore" => "write_claude_agents_restore",
            "/api/graph/annotations" => "write_graph_annotations",
            "/api/unified/tencent/invoke" => "write_unified_tencent_invoke",
            "/api/harness/settings" => "write_harness_settings",
            "/api/repos/import" => "write_repos_import",
            "/api/repos/remove" => "write_repos_remove",
            "/api/repos/reindex" => "write_repos_reindex",
            "/api/excluded" => "write_excluded",
            "/api/excluded/remove" => "write_excluded_remove",
            _ => return None,
        }
    };
    Some(route)
}

fn main() {
    let mut bytes = Vec::new();
    if io::stdin().take(513).read_to_end(&mut bytes).is_err() || bytes.len() > 512 {
        std::process::exit(2);
    }
    let request: Request = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => std::process::exit(2),
    };
    if request.schema != SCHEMA {
        std::process::exit(2);
    }
    println!("{}", json!({"route":classify(request.read, &request.key)}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_read_and_write_identity() {
        assert_eq!(classify(true, "/api/excluded"), Some("read_excluded"));
        assert_eq!(classify(false, "/api/excluded"), Some("write_excluded"));
        assert_eq!(classify(true, "/api/repos/remove"), None);
        assert_eq!(classify(false, "/api/harness"), None);
    }

    #[test]
    fn refuses_unexpected_wire_fields() {
        assert!(serde_json::from_str::<Request>(
            r#"{"schema":"singularity-dashboard-routes/v1","read":true,"key":"","headers":{}}"#
        )
        .is_err());
    }
}
