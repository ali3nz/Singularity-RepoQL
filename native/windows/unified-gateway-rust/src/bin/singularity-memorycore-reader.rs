//! Windows-local read-only Tencent MemoryCore adapter.
//!
//! One bounded JSON request is read from stdin and one JSON result is returned
//! on stdout. No credential, query, or upstream response is printed to stderr.
//! The upstream service is pinned to an explicit 127.0.0.1 HTTP origin. This
//! binary owns no memory storage, authorization, or write endpoints.
use serde_json::{json, Map, Value};
use std::{
    env, fs,
    io::{self, Read},
    path::Path,
    time::Duration,
};

const MAX_STDIN: u64 = 128 * 1024;
const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
const ALLOWED_V3_READ_PATHS: [&str; 6] = [
    "/v3/conversation/search",
    "/v3/atomic/search",
    "/v3/conversation/query",
    "/v3/atomic/query",
    "/v3/conversation/count",
    "/v3/atomic/count",
];
const ALLOWED_PATHS: [&str; 3] = [
    "/api/v1/chat-memory/team-assets",
    "/api/v1/chat-memory/search",
    "/api/v1/skill/list",
];

fn failure(code: &str) -> Value {
    json!({"ok": false, "code": code})
}
fn value_string(v: Option<&Value>, default: &str) -> String {
    match v {
        None | Some(Value::Null) => default.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => default.to_owned(),
    }
}
fn limit(v: Option<&Value>, default: usize, maximum: usize) -> usize {
    let n = v
        .and_then(|v| match v {
            Value::Number(n) => n.as_u64().and_then(|u| usize::try_from(u).ok()),
            Value::String(s) => s.parse::<usize>().ok(),
            _ => None,
        })
        .unwrap_or(default);
    if n == 0 {
        default
    } else {
        n.min(maximum)
    }
}
fn from_env_limit(name: &str, default: usize, max: usize) -> usize {
    limit(
        env::var(name)
            .ok()
            .as_ref()
            .map(|s| Value::String(s.clone()))
            .as_ref(),
        default,
        max,
    )
}
fn bounded_prefix(source: &str, allowed_bytes: usize) -> String {
    if source.len() <= allowed_bytes {
        return source.to_owned();
    }
    let mut last = 0;
    for (offset, ch) in source.char_indices() {
        let end = offset + ch.len_utf8();
        if end > allowed_bytes {
            break;
        }
        last = end;
    }
    source[..last].to_owned()
}
fn loopback_base() -> Result<String, &'static str> {
    let raw = env::var("MEMORYCORE_HUB_URL").unwrap_or_else(|_| "http://127.0.0.1:8125".into());
    let parsed = url::Url::parse(&raw).map_err(|_| "INVALID_LOOPBACK_ORIGIN")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("INVALID_LOOPBACK_ORIGIN");
    }
    Ok(format!(
        "http://127.0.0.1:{}",
        parsed.port().unwrap_or(8125)
    ))
}
fn key() -> Result<String, &'static str> {
    let path = env::var("MEMORYCORE_KEY_FILE").map_err(|_| "KEY_FILE_MISSING")?;
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err("KEY_FILE_INVALID");
    }
    let m = fs::symlink_metadata(p).map_err(|_| "KEY_FILE_INVALID")?;
    if m.file_type().is_symlink() || m.len() > 4096 {
        return Err("KEY_FILE_INVALID");
    }
    let mut parent = p.parent();
    while let Some(dir) = parent {
        if fs::symlink_metadata(dir)
            .map_err(|_| "KEY_FILE_INVALID")?
            .file_type()
            .is_symlink()
        {
            return Err("KEY_FILE_INVALID");
        }
        parent = dir.parent();
    }
    let contents = fs::read_to_string(p).map_err(|_| "KEY_FILE_UNREADABLE")?;
    let last = contents.lines().last().unwrap_or("").trim();
    if last.is_empty() || last.len() > 4096 {
        return Err("KEY_FILE_EMPTY");
    }
    Ok(last.to_owned())
}
struct Core {
    base: String,
    agent: ureq::Agent,
}
impl Core {
    fn new() -> Result<Self, &'static str> {
        let base = loopback_base()?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_millis(
                from_env_limit("MEMORYCORE_TIMEOUT_MS", 6000, 30000) as u64,
            ))
            .build();
        Ok(Self { base, agent })
    }
    fn post(&self, path: &str, body: &Value) -> Result<(u16, Option<Value>), &'static str> {
        if !ALLOWED_PATHS.contains(&path) {
            return Err("PATH_BLOCKED");
        }
        let user_key = key()?; // Read on every operation, never stored or displayed.
        let service = env::var("MEMORYCORE_SERVICE_ID").unwrap_or_else(|_| "default".into());
        if service.trim().is_empty() || service.len() > 128 {
            return Err("SERVICE_ID_INVALID");
        }
        let req = self
            .agent
            .post(&format!("{}{}", self.base, path))
            .set("Content-Type", "application/json")
            .set("x-tdai-user-key", &user_key)
            .set("x-tdai-service-id", &service);
        let response = match req.send_json(body) {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(_)) => return Err("NETWORK_FAILURE"),
        };
        let status = response.status();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "READ_FAILED")?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err("RESPONSE_TOO_LARGE");
        }
        let payload = serde_json::from_slice::<Value>(&bytes).ok();
        Ok((status, payload))
    }
}
fn envelope(payload: &Option<Value>, invalid: &str) -> Result<Value, Value> {
    let Some(Value::Object(obj)) = payload else {
        return Err(failure(invalid));
    };
    if let Some(code) = obj.get("code").and_then(Value::as_i64) {
        if code != 0 {
            return Err(failure(&format!("CORE:{code}")));
        }
    }
    Ok(Value::Object(obj.clone()))
}
fn resolve(core: &Core, team: &str) -> Value {
    let (status, payload) = match core.post(ALLOWED_PATHS[0], &json!({"team_id": team})) {
        Ok(r) => r,
        Err(e) => return failure(e),
    };
    if status != 200 {
        let mut out = if status == 401 || status == 403 {
            failure("AUTH_FAILED")
        } else {
            failure("TEAM_ASSETS_FAILED")
        };
        out["http"] = json!(status);
        return out;
    }
    let data = match envelope(&payload, "TEAM_ASSETS_PARSE_FAILED") {
        Ok(v) => v,
        Err(v) => return v,
    };
    let raw = data.pointer("/data/items");
    if raw.is_some_and(|v| !v.is_array()) {
        return failure("TEAM_ASSETS_SCHEMA_INVALID");
    }
    let mut blocks = Map::<String, Value>::new();
    if let Some(items) = raw.and_then(Value::as_array) {
        for item in items {
            let title = value_string(item.get("title"), "");
            let id = value_string(item.get("id"), "");
            if !id.is_empty() {
                if let Some(agent) = title.strip_prefix("Memory of ") {
                    if !agent.is_empty() {
                        blocks.insert(agent.to_owned(), Value::String(id));
                    }
                }
            }
        }
    }
    json!({"ok": true, "blocks": blocks})
}
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        _ => true,
    }
}
fn js_numeric_value(value: Option<&Value>) -> Option<Value> {
    let v = value?;
    let n = if v.is_null() {
        0.0
    } else if let Value::String(s) = v {
        s.parse::<f64>().ok()?
    } else {
        js_score(Some(v))
    };
    if !n.is_finite() {
        return None;
    }
    if n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        Some(json!(n as i64))
    } else {
        Some(json!(n))
    }
}
fn js_score(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(v)) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        Some(Value::String(s)) => s
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}
fn search(core: &Core, req: &Value) -> Value {
    let query = value_string(req.get("query"), "");
    if query.trim().is_empty() {
        return failure("EMPTY_QUERY");
    }
    if query.len() > 65536 {
        return failure("QUERY_TOO_LARGE");
    }
    let team = value_string(req.get("team"), "");
    let agent = value_string(req.get("agent"), "general");
    let layer = value_string(req.get("layer"), "L1").to_uppercase();
    if layer != "L0" && layer != "L1" {
        return failure("INVALID_LAYER");
    }
    let default_limit = if layer == "L0" {
        from_env_limit("MEMORYCORE_L0_LIMIT", 3, 10)
    } else {
        from_env_limit("MEMORYCORE_L1_LIMIT", 5, 10)
    };
    let lim = limit(req.get("limit"), default_limit, 10);
    let resolved = resolve(core, &team);
    if resolved.get("ok").and_then(Value::as_bool) != Some(true) {
        return resolved;
    }
    let Some(bid) = resolved
        .get("blocks")
        .and_then(|b| b.get(agent.as_str()))
        .and_then(Value::as_str)
    else {
        return if agent == "general" {
            json!({"ok": false, "code":"BLOCK_NOT_FOUND", "agent": agent})
        } else {
            json!({"ok": false, "code":"AGENT_BLOCK_NOT_FOUND", "agent": agent, "note":"strict identity: no fallback to another agent's block (ticket 776)"})
        };
    };
    let bid = bid.to_owned();
    let (status, payload) = match core.post(
        ALLOWED_PATHS[1],
        &json!({"block_id": bid, "query": query, "layer": layer, "limit": lim}),
    ) {
        Ok(r) => r,
        Err(e) => return failure(e),
    };
    if status != 200 {
        let code = if status == 401 || status == 403 {
            "AUTH_FAILED"
        } else if status == 404 {
            "BLOCK_NOT_FOUND"
        } else {
            "SEARCH_FAILED"
        };
        return json!({"ok":false,"code":code,"http":status});
    }
    let data = match envelope(&payload, "SEARCH_PARSE_FAILED") {
        Ok(v) => v,
        Err(v) => return v,
    };
    let Some(items) = data.pointer("/data/items").and_then(Value::as_array) else {
        return failure("SEARCH_SCHEMA_INVALID");
    };
    let max_bytes = from_env_limit("MEMORYCORE_BUDGET_BYTES", 6000, 131072);
    let mut used = 0;
    let mut results = Vec::new();
    for item in items.iter().take(lim) {
        let mut body = value_string(
            item.get("body")
                .filter(|v| !v.is_null())
                .or_else(|| item.get("content")),
            "",
        );
        let size = body.len();
        let truncated = used + size > max_bytes;
        if truncated {
            body = bounded_prefix(&body, max_bytes.saturating_sub(used));
        }
        let added = body.len();
        let mut out = json!({
            "id": value_string(item.get("id"), ""),
            "score": js_score(item.get("score")),
            "created_at": item.get("created_at").filter(|v| !v.is_null()).or_else(|| item.get("timestamp")).cloned().unwrap_or(Value::Null),
            "title": value_string(item.get("title"), ""),
            "body": body,
            "tags": item.get("tags").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
            "refs": item.get("refs").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
            "block": bid,
            "layer": layer,
        });
        used += added;
        if truncated {
            out["truncated"] = json!(true);
        }
        results.push(out);
        if truncated {
            break;
        }
    }
    json!({"ok":true,"block":bid,"agent":agent,"layer":layer,"results":results,"bytesUsed":used})
}
fn skill_list(core: &Core, req: &Value) -> Value {
    let skill_team = value_string(req.get("skillTeam"), "");
    let skill_agent = value_string(req.get("skillAgent"), "");
    let lim = limit(
        req.get("topN"),
        from_env_limit("MEMORYCORE_SKILL_TOP_N", 6, 12),
        12,
    );
    let prefix = value_string(req.get("namePrefix"), "");
    let status = value_string(req.get("status"), "active");
    let mut filters = Map::<String, Value>::new();
    if !prefix.trim().is_empty() {
        filters.insert(
            "name_prefix".into(),
            json!(prefix.trim().chars().take(64).collect::<String>()),
        );
    }
    if !status.is_empty() {
        filters.insert("status".into(), json!([status]));
    }
    let body = json!({"team_id":skill_team,"agent_id":skill_agent,"filters":filters,"pagination":{"limit":lim}});
    let (http, payload) = match core.post(ALLOWED_PATHS[2], &body) {
        Ok(r) => r,
        Err(e) => return failure(e),
    };
    let Some(data) = payload else {
        return json!({"ok":false,"code":"SKILL_LIST_FAILED","http":http});
    };
    let Some(code) = data.get("code").and_then(Value::as_i64) else {
        return failure("CORE:NO_ENVELOPE");
    };
    if code != 0 {
        return failure(&format!("CORE:{code}"));
    }
    let items = data.pointer("/data/items").and_then(Value::as_array);
    let mut skills = Vec::new();
    let mut bytes = 0;
    for item in items.into_iter().flatten().take(lim) {
        let version = js_numeric_value(item.get("version"));
        let metadata = item
            .get("metadata")
            .filter(|m| m.is_array() || m.is_object())
            .cloned()
            .unwrap_or(Value::Null);
        let out = json!({
            "name":value_string(item.get("name"),""),
            "skillId":value_string(item.get("skill_id"),""),
            "version": version,
            "isHead": js_truthy(item.get("is_head")),
            "status":value_string(item.get("status"),"active"),
            "description":item.get("description").and_then(Value::as_str).unwrap_or("").chars().take(200).collect::<String>(),
            "team":value_string(item.get("team_id"), &skill_team),
            "agent":value_string(item.get("owner_agent_id"), &skill_agent),
            "updated_at_ms":item.get("updated_at_ms").cloned().unwrap_or(Value::Null),
            "metadata":metadata,
        });
        bytes += serde_json::to_vec(&out).map(|v| v.len()).unwrap_or(0);
        skills.push(out);
    }
    json!({"ok":true,"skills":skills,"bytesUsed":bytes})
}
// Native Windows delegated and parent memory read transport. The owner passes
// only an already-authorized read payload over stdin; the binary never grants
// namespace access and never accepts a write endpoint. Secret values are read
// directly from the installation's memory.json, never through argv or stdin.
fn v3_read(req: &Value) -> Value {
    let path = value_string(req.get("path"), "");
    if !ALLOWED_V3_READ_PATHS.contains(&path.as_str()) {
        return failure("V3_READ_PATH_BLOCKED");
    }
    let Some(body) = req.get("body").filter(|v| v.is_object()) else {
        return failure("V3_BODY_INVALID");
    };
    let Ok(config_file) = env::var("MEMORYCORE_V3_CONFIG_FILE") else {
        return failure("V3_CONFIG_MISSING");
    };
    let source = Path::new(&config_file);
    if !source.is_absolute() || !source.is_file() {
        return failure("V3_CONFIG_INVALID");
    }
    let Ok(meta) = fs::symlink_metadata(source) else {
        return failure("V3_CONFIG_INVALID");
    };
    if meta.file_type().is_symlink() || meta.len() > 65536 {
        return failure("V3_CONFIG_INVALID");
    }
    let mut parent = source.parent();
    while let Some(dir) = parent {
        if fs::symlink_metadata(dir)
            .map(|v| v.file_type().is_symlink())
            .unwrap_or(true)
        {
            return failure("V3_CONFIG_INVALID");
        }
        parent = dir.parent();
    }
    let Ok(contents) = fs::read_to_string(source) else {
        return failure("V3_CONFIG_UNREADABLE");
    };
    let Ok(cfg) = serde_json::from_str::<Value>(&contents) else {
        return failure("V3_CONFIG_INVALID");
    };
    let from_cfg = |name: &str| value_string(cfg.get(name), "");
    let gateway_key = env::var("GHOST_MC_SERVICE_KEY")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            let key = from_cfg("gatewayKey");
            if !key.is_empty() {
                key
            } else {
                from_cfg("userKey")
            }
        });
    if gateway_key.is_empty() || gateway_key.len() > 4096 {
        return failure("V3_KEY_MISSING");
    }
    let user_key = env::var("GHOST_MC_USER_KEY")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            let key = from_cfg("userKey");
            if !key.is_empty() {
                key
            } else {
                gateway_key.clone()
            }
        });
    if user_key.len() > 4096 {
        return failure("V3_KEY_INVALID");
    }
    let service_id = env::var("GHOST_MC_SERVICE_ID")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            let key = from_cfg("serviceId");
            if !key.is_empty() {
                key
            } else {
                "default".into()
            }
        });
    if service_id.len() > 128 {
        return failure("V3_SERVICE_ID_INVALID");
    }
    let auth_prefix = {
        let key = from_cfg("authPrefix");
        if !key.is_empty() {
            key
        } else {
            "Bearer ".into()
        }
    };
    if auth_prefix.len() > 128 {
        return failure("V3_AUTH_PREFIX_INVALID");
    }
    let base = env::var("GHOST_MC_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            let host = from_cfg("hostBaseUrl");
            if !host.is_empty() {
                host
            } else {
                let url = from_cfg("baseUrl");
                if !url.is_empty() && !url.contains("memory-core:") {
                    url
                } else {
                    "http://127.0.0.1:8420".into()
                }
            }
        });
    let Ok(parsed) = url::Url::parse(&base) else {
        return failure("INVALID_LOOPBACK_ORIGIN");
    };
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return failure("INVALID_LOOPBACK_ORIGIN");
    }
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(20))
        .build();
    let address = format!("http://127.0.0.1:{}{}", parsed.port().unwrap_or(8420), path);
    let response = agent
        .post(&address)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("{auth_prefix}{gateway_key}"))
        .set("x-tdai-user-key", &user_key)
        .set("x-tdai-service-id", &service_id)
        .send_json(body);
    let response = match response {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(_)) => return failure("V3_NETWORK_FAILURE"),
    };
    if !(200..300).contains(&response.status()) {
        return failure("V3_HTTP_FAILURE");
    }
    let mut buf = Vec::new();
    if response
        .into_reader()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut buf)
        .is_err()
    {
        return failure("V3_READ_FAILED");
    }
    if buf.len() as u64 > MAX_RESPONSE {
        return failure("V3_RESPONSE_TOO_LARGE");
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&buf) else {
        return failure("V3_RESPONSE_INVALID");
    };
    json!({"ok":true,"payload":payload})
}

fn execute(req: &Value) -> Value {
    let op = value_string(req.get("operation"), "");
    if !["resolveBlocks", "search", "skillList", "v3Read"].contains(&op.as_str()) {
        return failure("OPERATION_BLOCKED");
    }
    if op == "v3Read" {
        return v3_read(req);
    }
    let team = value_string(req.get("team"), "");
    if team.is_empty() || team.len() > 256 {
        return failure("TEAM_ID_INVALID");
    }
    let Ok(core) = Core::new() else {
        return failure("INVALID_LOOPBACK_ORIGIN");
    };
    match op.as_str() {
        "resolveBlocks" => resolve(&core, &team),
        "search" => search(&core, req),
        "skillList" => skill_list(&core, req),
        _ => failure("OPERATION_BLOCKED"),
    }
}
fn main() {
    let mut buf = Vec::new();
    let result = match io::stdin().take(MAX_STDIN + 1).read_to_end(&mut buf) {
        Ok(_) if (buf.len() as u64) <= MAX_STDIN => match serde_json::from_slice::<Value>(&buf) {
            Ok(req) if req.is_object() => execute(&req),
            _ => failure("BAD_REQUEST"),
        },
        _ => failure("REQUEST_TOO_LARGE"),
    };
    println!("{result}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_budget_cuts_only_on_character_boundaries() {
        assert_eq!(bounded_prefix("abc😀z", 4), "abc");
        assert_eq!(bounded_prefix("abc😀z", 7), "abc😀");
        assert_eq!(bounded_prefix("😀", 3), "");
    }
    #[test]
    fn request_limits_are_bounded() {
        assert_eq!(limit(Some(&json!(0)), 3, 10), 3);
        assert_eq!(limit(Some(&json!(50)), 3, 10), 10);
        assert_eq!(limit(Some(&json!("4")), 3, 10), 4);
    }
    #[test]
    fn unknown_operation_is_blocked_without_network() {
        assert_eq!(
            execute(&json!({"operation":"add","team":"t"}))["code"],
            "OPERATION_BLOCKED"
        );
    }
}
