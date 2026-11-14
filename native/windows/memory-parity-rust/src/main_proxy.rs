//! Parent-session memory routing decisions over sanitized boolean evidence.
//!
//! This policy receives no tokens, provider URLs, credential helpers, or
//! private settings values. The existing JavaScript owner still performs the
//! merge and validates the Rust decision before it may return a configuration.
use serde_json::{json, Value};

fn reject() -> Value {
    json!({"ok":false,"code":"INVALID_MAIN_MEMORY_FACTS"})
}

struct Facts {
    owns_endpoint: bool,
    endpoint_present: bool,
    foreign_endpoint: bool,
    api_key: bool,
    bedrock: bool,
    vertex: bool,
    foundry: bool,
    helper: bool,
}
impl Facts {
    fn from(input: &Value) -> Option<Self> {
        let flags = input.get("facts")?.as_object()?;
        let b = |key: &str| -> Option<bool> { flags.get(key)?.as_bool() };
        Some(Self {
            owns_endpoint: b("ownsEndpoint")?,
            endpoint_present: b("endpointPresent")?,
            foreign_endpoint: b("foreignEndpoint")?,
            api_key: b("apiKey")?,
            bedrock: b("bedrock")?,
            vertex: b("vertex")?,
            foundry: b("foundry")?,
            helper: b("helper")?,
        })
    }
    fn conflicts(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.foreign_endpoint {
            out.push("ANTHROPIC_BASE_URL is set to another endpoint");
        }
        if self.api_key {
            out.push("ANTHROPIC_API_KEY is set (existing Anthropic auth)");
        }
        if self.bedrock {
            out.push("Bedrock routing is configured");
        }
        if self.vertex {
            out.push("Vertex routing is configured");
        }
        if self.foundry {
            out.push("Foundry routing is configured");
        }
        if self.helper {
            out.push("apiKeyHelper is configured");
        }
        out
    }
}

pub fn offline_state(input: &Value) -> Value {
    let Some(f) = Facts::from(input) else {
        return reject();
    };
    let conflicts = f.conflicts();
    let detail = conflicts.join("; ");
    let (state, detail) = if f.owns_endpoint && !conflicts.is_empty() {
        (
            "CONFLICTED",
            format!("our endpoint is set but overridden elsewhere: {detail}"),
        )
    } else if !f.owns_endpoint {
        (
            if f.endpoint_present {
                "CONFLICTED"
            } else {
                "DISABLED"
            },
            detail,
        )
    } else {
        (
            "CONFIGURED",
            "settings point at the Singularity proxy; run with --probe for VERIFIED".to_string(),
        )
    };
    json!({"ok":true,"value":{"state":state,"detail":detail}})
}

pub fn integration_plan(input: &Value) -> Value {
    let Some(f) = Facts::from(input) else {
        return reject();
    };
    let Some(replace) = input.get("replaceProvider").and_then(Value::as_bool) else {
        return reject();
    };
    let Some(write_url) = input.get("writeUrl").and_then(Value::as_bool) else {
        return reject();
    };
    let Some(write_token) = input.get("writeToken").and_then(Value::as_bool) else {
        return reject();
    };
    let Some(write_model) = input.get("writeModel").and_then(Value::as_bool) else {
        return reject();
    };
    let conflicts = f.conflicts();
    let mut reasons = conflicts.clone();
    let (mode, changed) = if f.owns_endpoint {
        reasons.clear();
        ("verified-existing", write_token || write_model)
    } else if !conflicts.is_empty() && !replace {
        reasons.push("explicit --replace-provider consent required to change provider routing");
        ("refused-conflict", false)
    } else {
        (
            if conflicts.is_empty() {
                "merged"
            } else {
                "merged-over-replace-consent"
            },
            write_url || write_token || write_model,
        )
    };
    json!({"ok":true,"value":{"mode":mode,"changed":changed,"reasons":reasons}})
}

/// Decide which keys an uninstall is permitted to restore or remove.
/// Values and original receipts never leave the caller. Only byte-for-byte
/// receipt ownership checks, performed in JavaScript, are passed as booleans.
pub fn uninstall_plan(input: &Value) -> Value {
    let Some(rows) = input.get("keys").and_then(Value::as_array) else {
        return reject();
    };
    let approved = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
    ];
    if rows.len() != approved.len() {
        return reject();
    }
    let mut changed = Vec::new();
    let mut operations = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(obj) = row.as_object() else {
            return reject();
        };
        if obj.len() != 4 || obj.get("key").and_then(Value::as_str) != Some(approved[index]) {
            return reject();
        }
        let Some(present) = obj.get("present").and_then(Value::as_bool) else {
            return reject();
        };
        let Some(owned) = obj.get("matchesReceipt").and_then(Value::as_bool) else {
            return reject();
        };
        let Some(restore) = obj.get("restorePrevious").and_then(Value::as_bool) else {
            return reject();
        };
        if present && owned {
            changed.push(approved[index]);
            operations.push(
                json!({"key": approved[index], "action": if restore {"restore"} else {"remove"}}),
            );
        }
    }
    json!({"ok":true,"value":{"changedKeys":changed,"operations":operations}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn f() -> Value {
        json!({"facts": {"ownsEndpoint":true,"endpointPresent":true,
          "foreignEndpoint":false,"apiKey":false,"bedrock":false,
          "vertex":false,"foundry":false,"helper":false},
          "replaceProvider":false,"writeUrl":false,"writeToken":false,"writeModel":false})
    }
    #[test]
    fn never_claims_live_readback() {
        assert_eq!(offline_state(&f())["value"]["state"], "CONFIGURED");
        assert_ne!(offline_state(&f())["value"]["state"], "VERIFIED");
    }
    #[test]
    fn refuses_unauthorised_provider_replacement() {
        let mut facts = f();
        facts["facts"]["ownsEndpoint"] = json!(false);
        facts["facts"]["foreignEndpoint"] = json!(true);
        facts["writeUrl"] = json!(true);
        assert_eq!(
            integration_plan(&facts)["value"]["mode"],
            "refused-conflict"
        );
        assert_eq!(integration_plan(&facts)["value"]["changed"], false);
        facts["replaceProvider"] = json!(true);
        assert_eq!(
            integration_plan(&facts)["value"]["mode"],
            "merged-over-replace-consent"
        );
    }
    #[test]
    fn uninstall_requires_receipt_and_preserves_other_values() {
        let input = json!({"keys":[
          {"key":"ANTHROPIC_BASE_URL","present":true,"matchesReceipt":true,"restorePrevious":false},
          {"key":"ANTHROPIC_AUTH_TOKEN","present":true,"matchesReceipt":false,"restorePrevious":true},
          {"key":"ANTHROPIC_MODEL","present":false,"matchesReceipt":true,"restorePrevious":true}
        ]});
        let output = uninstall_plan(&input);
        assert_eq!(
            output["value"]["changedKeys"],
            json!(["ANTHROPIC_BASE_URL"])
        );
        assert_eq!(output["value"]["operations"][0]["action"], "remove");
        let mut bad = input.clone();
        bad["keys"][1]["key"] = json!("UNRELATED_PROVIDER");
        assert_eq!(uninstall_plan(&bad)["code"], "INVALID_MAIN_MEMORY_FACTS");
    }
    #[test]
    fn does_not_accept_missing_or_string_flags() {
        assert_eq!(
            integration_plan(&json!({}))["code"],
            "INVALID_MAIN_MEMORY_FACTS"
        );
        let mut facts = f();
        facts["facts"]["apiKey"] = json!("secret-value");
        assert_eq!(offline_state(&facts)["code"], "INVALID_MAIN_MEMORY_FACTS");
    }
}
