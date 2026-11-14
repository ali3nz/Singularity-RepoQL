//! Opt-in, single-request Windows MemoryCore conversation writer.
//!
//! IMPORTANT: this is a transport, not an authorization or idempotency authority.
//! Callers must authorize identity, query before writes, and verify stored records
//! after writes. On timeout or ambiguous delivery, NEVER automatically retry.
//! The only allowed mutation is /v3/conversation/add on the loopback MemoryCore.
//! The document transport also supports exact, scoped conversation readback.
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read},
    path::Path,
    time::Duration,
};

const MAX_REQUEST: u64 = 128 * 1024;
const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
const ALLOWED_PATH: &str = "/v3/conversation/add";
const DOC_QUERY_PATH: &str = "/v3/conversation/query";
const DOC_SEARCH_PATH: &str = "/v3/conversation/search";

fn fail(code: &str) -> Value {
    json!({"ok": false, "code": code})
}
fn get_string<'a>(source: &'a Value, key: &str) -> Option<&'a str> {
    source
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}
fn config_text(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}
fn source_config(doc: bool) -> Result<Value, &'static str> {
    let name = if doc {
        "SINGULARITY_DOC_WRITE_CONFIG"
    } else {
        "MEMORYCORE_V3_CONFIG_FILE"
    };
    let file = env::var(name).map_err(|_| "CONFIG_MISSING")?;
    let path = Path::new(&file);
    // Windows UNC shares and device namespaces are not acceptable locations
    // for credentials used by an installed local MemoryCore instance.
    #[cfg(windows)]
    if file.starts_with("\\\\") || file.starts_with("//") {
        return Err("CONFIG_INVALID");
    }
    if !path.is_absolute() || !path.is_file() {
        return Err("CONFIG_INVALID");
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "CONFIG_INVALID")?;
    if !plain(&meta) || !meta.is_file() || meta.len() > 65536 {
        return Err("CONFIG_INVALID");
    }
    let mut parent = path.parent();
    while let Some(dir) = parent {
        let meta = fs::symlink_metadata(dir).map_err(|_| "CONFIG_INVALID")?;
        if !plain(&meta) || !meta.is_dir() {
            return Err("CONFIG_INVALID");
        }
        parent = dir.parent();
    }
    let mut content = String::new();
    fs::File::open(path)
        .and_then(|f| f.take(65_537).read_to_string(&mut content))
        .map_err(|_| "CONFIG_UNREADABLE")?;
    if content.len() > 65_536 {
        return Err("CONFIG_INVALID");
    }
    let value: Value = serde_json::from_str(&content).map_err(|_| "CONFIG_INVALID")?;
    if !value.is_object() {
        return Err("CONFIG_INVALID");
    }
    Ok(value)
}
fn plain(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !meta.file_type().is_symlink()
}

fn local_origin(base: &str) -> Result<String, &'static str> {
    let uri = url::Url::parse(base).map_err(|_| "NON_LOCAL_ORIGIN")?;
    if uri.scheme() != "http"
        || uri.host_str() != Some("127.0.0.1")
        || uri.port().is_none()
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.path() != "/"
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        return Err("NON_LOCAL_ORIGIN");
    }
    Ok(format!(
        "http://127.0.0.1:{}",
        uri.port().ok_or("NON_LOCAL_ORIGIN")?
    ))
}
fn validate_body(body: &Value) -> Result<(), &'static str> {
    if !body.is_object() {
        return Err("BODY_INVALID");
    }
    // A write must have a precise caller-established namespace and a stable
    // reconciliation identity. Native code never chooses these values.
    for key in ["team_id", "user_id", "agent_id", "session_id", "task_id"] {
        if get_string(body, key).is_none_or(|s| s.len() > 256) {
            return Err("IDENTITY_INVALID");
        }
    }
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("MESSAGES_INVALID")?;
    if messages.is_empty() || messages.len() > 100 {
        return Err("MESSAGES_INVALID");
    }
    for message in messages {
        if !message.is_object()
            || !matches!(
                get_string(message, "role"),
                Some("assistant" | "user" | "system" | "tool")
            )
            || message.get("content").and_then(Value::as_str).is_none()
        {
            return Err("MESSAGES_INVALID");
        }
    }
    Ok(())
}
fn valid_document_body(body: &Value) -> bool {
    if body["agent_id"] != "docs-keeper" || body["session_id"] != "singularity-documentation" {
        return false;
    }
    let Some(id) = body["task_id"].as_str() else {
        return false;
    };
    let Some(messages) = body["messages"].as_array() else {
        return false;
    };
    let hex = |s: &str| {
        s.len() == 8
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let parts: Vec<_> = id.split('-').collect();
    if matches!(parts.as_slice(), ["docs", id, rev, chunk]
            if hex(id) && rev.strip_prefix('r').is_some_and(hex)
            && chunk.strip_prefix('c').is_some_and(|n| n.len() == 2 && n.bytes().all(|b| b.is_ascii_digit())
                && n.parse::<u8>().is_ok_and(|v| (1..=64).contains(&v))))
    {
        return matches!(messages.as_slice(), [user, ack] if user["role"] == "user" && ack["role"] == "assistant");
    }
    let Some((doc, revisions)) = id
        .strip_prefix("docs-superseded:")
        .and_then(|s| s.split_once(':'))
    else {
        return false;
    };
    let Some((old, new)) = revisions.split_once("->") else {
        return false;
    };
    if !hex(doc) || !hex(old) || !hex(new) || old == new {
        return false;
    }
    let expected = format!("[{id}] Documentation revision {old} of document {doc} is SUPERSEDED by revision {new}. Never present revision {old} as current guidance.");
    matches!(messages.as_slice(), [user] if user["role"] == "user" && user["content"].as_str() == Some(&expected))
}

// Match the host's retry contract. Only a generated ingestion header time
// may differ. The contents after the first blank line are kept verbatim.
fn normalize_header(content: &str) -> String {
    let Some((header, tail)) = content.split_once("\n\n") else {
        return content.to_owned();
    };
    let mut parts = header.split('\n').peekable();
    let mut result = String::new();
    while let Some(line) = parts.next() {
        result.push_str(
            if line
                .strip_prefix("ingested: ")
                .is_some_and(|s| !s.is_empty())
            {
                "ingested:"
            } else {
                line
            },
        );
        if parts.peek().is_some() {
            result.push('\n');
        }
    }
    result.push_str("\n\n");
    result.push_str(tail);
    result
}

fn exact_document_readback(payload: &Value, body: &Value) -> bool {
    let Some(rows) = payload["data"]["messages"]
        .as_array()
        .filter(|a| a.len() < 100)
    else {
        return false;
    };
    body["messages"].as_array().is_some_and(|expected| {
        expected.iter().all(|message| {
            let content = normalize_header(message["content"].as_str().unwrap_or_default());
            rows.iter().any(|row| {
                row["task_id"] == body["task_id"]
                    && row["role"] == message["role"]
                    && row["content"]
                        .as_str()
                        .is_some_and(|actual| normalize_header(actual) == content)
            })
        })
    })
}

fn write(req: &Value) -> Value {
    let operation = req.get("operation").and_then(Value::as_str);
    let readback = operation == Some("docVerify");
    let marker_lookup = operation == Some("docFindMarker");
    let doc = readback || marker_lookup || operation == Some("docWrite");
    let expected_path = if readback {
        DOC_QUERY_PATH
    } else if marker_lookup {
        DOC_SEARCH_PATH
    } else {
        ALLOWED_PATH
    };
    if (!doc && operation != Some("v3Write"))
        || req.get("path").and_then(Value::as_str) != Some(expected_path)
    {
        return fail("OPERATION_BLOCKED");
    }
    let Some(body) = req.get("body") else {
        return fail("BODY_INVALID");
    };
    if marker_lookup {
        let valid_marker = body["query"].as_str().is_some_and(|marker| {
            marker.len() <= 4096
                && !marker.chars().any(char::is_control)
                && marker.ends_with(']')
                && (marker.starts_with("[doc-ref:") || marker.starts_with("[docs-superseded:"))
        });
        if body.as_object().is_none_or(|fields| fields.len() != 5)
            || body["agent_id"] != "docs-keeper"
            || ["team_id", "user_id"]
                .iter()
                .any(|key| get_string(body, key).is_none_or(|s| s.len() > 256))
            || !matches!(body["limit"].as_u64(), Some(5 | 10))
            || !valid_marker
        {
            return fail("DOCUMENT_SCOPE_INVALID");
        }
    } else {
        if let Err(code) = validate_body(body) {
            return fail(code);
        }
        if doc && !valid_document_body(body) {
            return fail("DOCUMENT_SCOPE_INVALID");
        }
    }
    let config = match source_config(doc) {
        Ok(value) => value,
        Err(code) => return fail(code),
    };
    let (gateway, user, service, prefix, url) = if doc {
        let field = |key: &str, legacy: &str| {
            config
                .get(key)
                .or_else(|| config.get(legacy))
                .and_then(Value::as_str)
        };
        let (Some(gateway), Some(user), Some(service), Some(prefix)) = (
            field("gatewayKey", "gatewayKey"),
            field("userKey", "user_key"),
            field("serviceId", "service_id"),
            if config.get("authPrefix").is_some() || config.get("auth_prefix").is_some() {
                field("authPrefix", "auth_prefix")
            } else {
                Some("Bearer ")
            },
        ) else {
            return fail("DOCUMENT_CONFIG_INVALID");
        };
        if gateway.is_empty() || user.is_empty() || service.is_empty() {
            return fail("DOCUMENT_CONFIG_INVALID");
        }
        // The parent loaded the service identity before publishing the
        // durable intent. Refuse a reconfigured service before network I/O.
        if req.get("expected_service").and_then(Value::as_str) != Some(service) {
            return fail("DOCUMENT_TARGET_CHANGED");
        }
        let Ok(url) = env::var("SINGULARITY_DOC_WRITE_ORIGIN") else {
            return fail("DOCUMENT_CONFIG_INVALID");
        };
        (
            gateway.to_owned(),
            user.to_owned(),
            service.to_owned(),
            prefix.to_owned(),
            url,
        )
    } else {
        let source_key = config_text(&config, "gatewayKey");
        let fallback_key = config_text(&config, "userKey");
        let gateway = env::var("GHOST_MC_SERVICE_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                if source_key.is_empty() {
                    fallback_key.clone()
                } else {
                    source_key
                }
            });
        if gateway.is_empty() || gateway.len() > 4096 {
            return fail("KEY_INVALID");
        }
        let user = env::var("GHOST_MC_USER_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                if fallback_key.is_empty() {
                    gateway.clone()
                } else {
                    fallback_key
                }
            });
        if user.len() > 4096 {
            return fail("USER_KEY_INVALID");
        }
        let service = env::var("GHOST_MC_SERVICE_ID")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                let value = config_text(&config, "serviceId");
                if value.is_empty() {
                    "default".into()
                } else {
                    value
                }
            });
        if service.is_empty() || service.len() > 128 {
            return fail("SERVICE_INVALID");
        }
        let prefix = {
            let v = config_text(&config, "authPrefix");
            if v.is_empty() {
                "Bearer ".into()
            } else {
                v
            }
        };
        if prefix.len() > 128 {
            return fail("PREFIX_INVALID");
        }
        let url = env::var("GHOST_MC_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                let host = config_text(&config, "hostBaseUrl");
                if !host.is_empty() {
                    host
                } else {
                    let url = config_text(&config, "baseUrl");
                    if !url.is_empty() && !url.contains("memory-core:") {
                        url
                    } else {
                        "http://127.0.0.1:8420".into()
                    }
                }
            });
        (gateway, user, service, prefix, url)
    };
    if [
        (&gateway, 4096),
        (&user, 4096),
        (&service, 128),
        (&prefix, 128),
    ]
    .iter()
    .any(|(s, max)| s.len() > *max || !s.bytes().all(|b| (32..=126).contains(&b)))
    {
        return fail("INVALID_CREDENTIAL_FIELDS");
    }
    let base = match local_origin(&url) {
        Ok(value) => value,
        Err(code) => return fail(code),
    };
    // No retries, redirects, request content logging or dynamic path selection.
    // A transport timeout could occur after upstream committed the write.
    let client = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .timeout(Duration::from_secs(20))
        .build();
    // Only the scope and task are sent during readback. Expected content
    // remains local and is compared with the gateway response below.
    let query = readback.then(|| {
        json!({
            "team_id":body["team_id"], "user_id":body["user_id"], "agent_id":body["agent_id"],
            "session_id":body["session_id"], "task_id":body["task_id"], "offset":0, "limit":100
        })
    });
    let result = client
        .post(&format!("{base}{expected_path}"))
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("{prefix}{gateway}"))
        .set("x-tdai-user-key", &user)
        .set("x-tdai-service-id", &service)
        .send_json(query.as_ref().unwrap_or(body));
    let response = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(_)) => return fail("DELIVERY_UNCERTAIN"),
    };
    if !(200..300).contains(&response.status()) {
        return fail("HTTP_FAILURE");
    }
    let mut bytes = Vec::new();
    if response
        .into_reader()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return fail("DELIVERY_UNCERTAIN");
    }
    if bytes.len() as u64 > MAX_RESPONSE {
        return fail("DELIVERY_UNCERTAIN");
    }
    let payload = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(value)) => Value::Object(value),
        _ => return fail("DELIVERY_UNCERTAIN"),
    };
    if doc {
        if payload.get("code").and_then(Value::as_i64) != Some(0)
            || payload.get("error").is_some_and(|error| !error.is_null())
        {
            return fail("DOCUMENT_WRITE_UNCONFIRMED");
        }
        if marker_lookup {
            let Some(rows) = payload["data"]["messages"]
                .as_array()
                .filter(|a| a.len() <= 100)
            else {
                return fail("DOCUMENT_SEARCH_UNCONFIRMED");
            };
            let marker = body["query"].as_str().expect("validated marker");
            json!({"ok": true, "visible": rows.iter().any(|row| row["content"].as_str()
                .is_some_and(|text| text.contains(marker)))})
        } else if readback {
            json!({"ok": true, "verified": exact_document_readback(&payload, body)})
        } else {
            json!({"ok": true, "accepted": true})
        }
    } else {
        json!({"ok": true, "payload": payload})
    }
}
fn main() {
    let mut bytes = Vec::new();
    let result = match io::stdin().take(MAX_REQUEST + 1).read_to_end(&mut bytes) {
        Ok(_) if (bytes.len() as u64) <= MAX_REQUEST => {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(req) => write(&req),
                Err(_) => fail("REQUEST_INVALID"),
            }
        }
        _ => fail("REQUEST_TOO_LARGE"),
    };
    println!("{result}");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_every_unapproved_endpoint() {
        assert_eq!(
            write(&json!({"operation":"v3Write","path":"/v3/atomic/delete","body":{}}))["code"],
            "OPERATION_BLOCKED"
        );
        assert_eq!(
            write(&json!({"operation":"v3Read","path":ALLOWED_PATH,"body":{}}))["code"],
            "OPERATION_BLOCKED"
        );
    }
    #[test]
    fn rejects_unscoped_write_before_config_io() {
        assert_eq!(
            write(&json!({"operation":"v3Write","path":ALLOWED_PATH,"body":{"messages":[]}}))
                ["code"],
            "IDENTITY_INVALID"
        );
    }
    #[test]
    fn restricts_origin() {
        assert!(local_origin("http://127.0.0.1:8420").is_ok());
        assert!(local_origin("http://127.0.0.1.attacker.invalid:8420").is_err());
        assert!(local_origin("http://127.0.0.1:8420/redirect").is_err());
        assert!(local_origin("https://127.0.0.1:8420").is_err());
    }
}
