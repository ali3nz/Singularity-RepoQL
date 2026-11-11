//! Unified RepoQL and Tencent MemoryCore dashboard data plane.
//! Deliberately loopback-only. Existing Python dashboard enforces operator identity,
//! Cloudflare Access, same-origin and capability-token controls before proxying.
//! Reads only from authoritative APIs. Never copies either memory graph into another.
// The unified usage response is a large nested json! literal; the default
// macro recursion limit is not enough once filtered Freebuff aggregates are added.
#![recursion_limit = "256"]
// The Windows gateway is a background application. Never allocate a console.
#![cfg_attr(windows, windows_subsystem = "windows")]
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use serde::Deserialize;
use std::{collections::{BTreeMap, HashMap, HashSet}, env, fs, io::{Read, Write}, path::{Path,PathBuf}, time::Duration};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MAX_BODY: usize = 128 * 1024;
const MAX_UPSTREAM: usize = 8 * 1024 * 1024;
const MAX_USAGE_FILE_BYTES: usize = 128 * 1024 * 1024;
const MAX_USAGE_ROWS: usize = 300_000;
const SOURCES: [(&str, &str); 6] = [
    ("freebuff-dockerhost", "Freebuff Desktop · dockerhost"),
    ("freebuff-webserver", "Freebuff Desktop · webserver"),
    ("codex-pro", "Codex Pro subscription"),
    ("claude-subscription", "Claude subscription"),
    ("opencode-go-dockerhost", "OpenCode Go · dockerhost"),
    ("openrouter", "OpenRouter API"),
];

struct Config {
    port: u16,
    repoql_base: String,
    repoql_token: PathBuf,
    tencent_base: String,
    tencent_service: String,
    tencent_key: PathBuf,
    wiki_ids: Vec<String>,
    hub_doc_prefix: String,
    usage_dir: PathBuf,
    writes: bool,
    gateway_key: PathBuf,
    openrouter_key: PathBuf,
    openrouter_management_key: PathBuf,
}
/// Usage sources whose newest receipt is older than this are reported stale (30 days).
const SOURCE_STALE_SECONDS: i64 = 30 * 24 * 3600;
/// Quota snapshots are polled hourly; older than two poll intervals they are stale.
const QUOTA_STALE_SECONDS: i64 = 2 * 3600;

fn envv(name: &str, default: &str) -> String { env::var(name).unwrap_or_else(|_| default.to_owned()) }
fn valid_base(raw: &str, loopback_only: bool) -> bool {
    let Ok(parsed)=url::Url::parse(raw) else {return false;};
    if !parsed.username().is_empty() || parsed.password().is_some()
       || parsed.query().is_some() || parsed.fragment().is_some()
       || parsed.path()!="/" {return false;}
    let loopback=parsed.host_str()==Some("127.0.0.1");
    if loopback_only {return parsed.scheme()=="http" && loopback && parsed.port().is_some();}
    parsed.scheme()=="https" || (parsed.scheme()=="http" && loopback && parsed.port().is_some())
}
fn config() -> Result<Config, String> {
    let repoql_base = envv("UNIFIED_REPOQL_BASE", "http://127.0.0.1:18100");
    let tencent_base = envv("UNIFIED_TENCENT_BASE", "");
    // Parse URLs rather than trusting string prefixes, which can hide userinfo
    // or redirect destinations. Credentials must never go to an unverified host.
    if !valid_base(&repoql_base, true) {
        return Err("UNIFIED_REPOQL_BASE must be loopback HTTP with a port".into());
    }
    // This is a Windows-local product. A secure off-host URL still points at
    // another machine's memory, so forbid all non-loopback Tencent origins.
    if !tencent_base.is_empty() && !valid_base(&tencent_base, true) {
        return Err("UNIFIED_TENCENT_BASE must be explicit loopback HTTP".into());
    }
    let required_file = |key: &str| -> Result<PathBuf, String> {
        let value = env::var(key).map_err(|_| format!("{key} is required"))?;
        let path = PathBuf::from(value);
        if !path.is_absolute() || !path.is_file() {
            return Err(format!("{key} must reference an existing absolute private file"));
        }
        Ok(path)
    };
    let repoql_token = required_file("UNIFIED_REPOQL_TOKEN_FILE")?;
    let gateway_key = required_file("UNIFIED_GATEWAY_TOKEN_FILE")?;
    let tencent_key = if tencent_base.is_empty() {
        PathBuf::new()
    } else {
        required_file("UNIFIED_TENCENT_USER_KEY_FILE")?
    };
    let hub_doc_prefix = envv("UNIFIED_HUB_DOC_URI_PREFIX", "");
    if !hub_doc_prefix.is_empty() && (!hub_doc_prefix.starts_with("github://")
        || !hub_doc_prefix.ends_with('/') || hub_doc_prefix.len() > 512
        || hub_doc_prefix.chars().any(char::is_whitespace)
        || hub_doc_prefix.contains('?') || hub_doc_prefix.contains('#')) {
        return Err("UNIFIED_HUB_DOC_URI_PREFIX must be an explicit github:// import root ending in /".into());
    }
    let usage_dir = PathBuf::from(envv("UNIFIED_USAGE_DIR", ""));
    if !usage_dir.as_os_str().is_empty() && !usage_dir.is_absolute() {
        return Err("UNIFIED_USAGE_DIR must be an explicit absolute local directory".into());
    }
    let port: u16 = envv("UNIFIED_PORT", "18101").parse().map_err(|_| "invalid UNIFIED_PORT")?;
    if port < 1024 { return Err("UNIFIED_PORT reserved/invalid".into()); }
    Ok(Config {
        port,
        repoql_base,
        repoql_token,
        tencent_base: tencent_base.trim_end_matches('/').to_string(),
        tencent_service: envv("UNIFIED_TENCENT_SERVICE_ID", ""),
        tencent_key,
        wiki_ids: envv("UNIFIED_TENCENT_WIKI_IDS", "").split(',').filter(|x| !x.trim().is_empty()).map(|x| x.trim().to_string()).collect(),
        // Hub document joins are opt-in and must match the installed Windows
        // RepoQL import. Never silently query Dockerhost's GitHub import.
        hub_doc_prefix,
        usage_dir,
        // Never enable Tencent memory mutation through the Windows UI gateway.
        // Agent memory writes belong to the separately authenticated connector.
        writes: false,
        gateway_key,
        openrouter_key: PathBuf::from(envv("UNIFIED_OPENROUTER_KEY_FILE", "")),
        openrouter_management_key: PathBuf::from(envv("UNIFIED_OPENROUTER_MANAGEMENT_KEY_FILE", "")),
    })
}
// Read the existing ACL-protected Windows configuration directly. This replaces
// the console PowerShell intermediary at logon. No bearer bytes enter argv.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsTaskConfig {
    binary: PathBuf,
    repoql_base: String,
    repoql_token_file: PathBuf,
    tencent_base: String,
    tencent_service_id: String,
    tencent_user_key_file: String,
    wiki_ids: Vec<String>,
    hub_doc_uri_prefix: String,
    gateway_token_file: PathBuf,
    usage_dir: String,
    port: u16,
}

fn windows_local_absolute(path: &Path) -> bool {
    if !path.is_absolute() { return false; }
    #[cfg(windows)] {
        use std::path::{Component, Prefix};
        return matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)));
    }
    #[cfg(not(windows))] { true }
}

fn apply_windows_task_config(path: &Path) -> Result<(), String> {
    if !windows_local_absolute(path) || !path.is_file() { return Err("local gateway config missing".into()); }
    let bytes=fs::read(path).map_err(|_| "gateway config unreadable".to_string())?;
    if bytes.len()>65536 { return Err("gateway config too large".into()); }
    let raw=bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes);
    let c: WindowsTaskConfig=serde_json::from_slice(raw).map_err(|_| "gateway config schema invalid".to_string())?;
    let running=env::current_exe().map_err(|_| "gateway executable identity unavailable".to_string())?;
    let expected=fs::canonicalize(&c.binary).map_err(|_| "gateway executable path unavailable".to_string())?;
    let actual=fs::canonicalize(&running).map_err(|_| "gateway current executable unavailable".to_string())?;
    if !windows_local_absolute(&c.binary) || !actual.to_string_lossy().eq_ignore_ascii_case(&expected.to_string_lossy()) {
        return Err("gateway executable does not match registered owner".into());
    }
    if c.port!=18101 || !valid_base(&c.repoql_base,true) ||
       (!c.tencent_base.is_empty() && !valid_base(&c.tencent_base,true)) ||
       !windows_local_absolute(&c.repoql_token_file) || !windows_local_absolute(&c.gateway_token_file) ||
       ( !c.tencent_base.is_empty() && (!windows_local_absolute(Path::new(&c.tencent_user_key_file)) || c.tencent_service_id.is_empty()) ) ||
       (!c.usage_dir.is_empty() && !windows_local_absolute(Path::new(&c.usage_dir))) ||
       c.wiki_ids.iter().any(|w| w.len()>256 || w.contains(',')) {
        return Err("gateway task config contains invalid Windows-local source".into());
    }
    // Files are ACL-protected and loaded by config() on each fresh process.
    // The graph gateway never silently switches to any other host.
    env::set_var("UNIFIED_PORT",c.port.to_string());
    env::set_var("UNIFIED_REPOQL_BASE",&c.repoql_base);
    env::set_var("UNIFIED_REPOQL_TOKEN_FILE",&c.repoql_token_file);
    env::set_var("UNIFIED_TENCENT_BASE",&c.tencent_base);
    env::set_var("UNIFIED_TENCENT_SERVICE_ID",&c.tencent_service_id);
    env::set_var("UNIFIED_TENCENT_USER_KEY_FILE",&c.tencent_user_key_file);
    env::set_var("UNIFIED_TENCENT_WIKI_IDS",c.wiki_ids.join(","));
    env::set_var("UNIFIED_HUB_DOC_URI_PREFIX",&c.hub_doc_uri_prefix);
    env::set_var("UNIFIED_GATEWAY_TOKEN_FILE",&c.gateway_token_file);
    env::set_var("UNIFIED_USAGE_DIR",&c.usage_dir);
    env::set_var("UNIFIED_TENCENT_WRITES","false");
    Ok(())
}

fn runtime_log(config_path: Option<&Path>, message: &str) {
    // The parent directory has already been given a private user/SYSTEM ACL.
    // Do not print tokens, config contents or data from memory responses.
    let Some(config)=config_path else { return; };
    if !windows_local_absolute(config) { return; }
    let Some(parent)=config.parent() else { return; };
    let path=parent.join("unified-gateway-runtime.log");
    if path.metadata().map(|m| m.len()>4*1024*1024).unwrap_or(false) {
        let _=fs::rename(&path,parent.join("unified-gateway-runtime.previous.log"));
    }
    if let Ok(mut file)=fs::OpenOptions::new().append(true).create(true).open(path) {
        let _=writeln!(file,"{} {}",Utc::now().to_rfc3339(),message);
    }
}

fn header_json() -> Header { Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap() }
fn reply(request: Request, code: u16, payload: Value) {
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    let response = Response::from_data(body).with_status_code(StatusCode(code))
        .with_header(header_json())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
    let _ = request.respond(response);
}
fn read_secret(path: &PathBuf) -> Result<String, String> {
    let key = fs::read_to_string(path).map_err(|_| "configured credential file unavailable")?;
    let key = key.trim().to_owned();
    if key.is_empty() { return Err("configured credential empty".into()); }
    Ok(key)
}
fn fetch_json(url: &str, authorization: &[(&str, String)], body: Option<&Value>) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(12)).redirects(0).build();
    let mut req = match body {Some(_) => agent.post(url), None => agent.get(url)};
    for (key, value) in authorization { req = req.set(key, value); }
    let result = match body {Some(value) => req.send_json(value.clone()), None => req.call()};
    let response = result.map_err(|e| match e {ureq::Error::Status(code, _) => format!("upstream_http_{code}"), _ => "upstream_connection_failed".to_string()})?;
    if response.header("Content-Length").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0) > MAX_UPSTREAM {
        return Err("upstream_response_too_large".into());
    }
    let mut reader = response.into_reader().take((MAX_UPSTREAM + 1) as u64);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|_| "upstream_body_read_failed")?;
    if bytes.len() > MAX_UPSTREAM { return Err("upstream_response_too_large".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "upstream_invalid_json".into())
}
fn bearer_authenticated(req: &Request, configured_key: &str) -> bool {
    // Compare entire value, without returning at the first unequal byte.
    let supplied = req.headers().iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h|h.value.as_str()).unwrap_or("");
    let expected = format!("Bearer {configured_key}");
    let a = supplied.as_bytes(); let b = expected.as_bytes();
    let mut difference = a.len() ^ b.len();
    for (x,y) in a.iter().zip(b.iter()) {difference |= usize::from(*x ^ *y);}
    difference == 0
}
fn openrouter(c: &Config) -> Value {
    let now=Utc::now().to_rfc3339();
    let mut key_info=json!({"status":"unavailable","reason":"api_key_not_configured"});
    let mut credits=json!({"status":"unavailable","reason":"management_key_not_configured"});
    if !c.openrouter_key.as_os_str().is_empty() {
        key_info=match read_secret(&c.openrouter_key) {
            Ok(token)=>match fetch_json("https://openrouter.ai/api/v1/key", &[("Authorization",format!("Bearer {token}"))],None) {
                Ok(result)=>{
                    let d=result.get("data").unwrap_or(&result);
                    json!({"status":"available","scope":"api_key","usage_usd":d.get("usage"),
                        "usage_daily_usd":d.get("usage_daily"),"usage_weekly_usd":d.get("usage_weekly"),
                        "usage_monthly_usd":d.get("usage_monthly"),"limit_usd":d.get("limit"),
                        "limit_remaining_usd":d.get("limit_remaining"),"is_free_tier":d.get("is_free_tier")})
                },Err(e)=>json!({"status":"unavailable","reason":e})
            },Err(_)=>json!({"status":"unavailable","reason":"configured_credential_unavailable"})
        };
    }
    if !c.openrouter_management_key.as_os_str().is_empty() {
        credits=match read_secret(&c.openrouter_management_key) {
            Ok(token)=>match fetch_json("https://openrouter.ai/api/v1/credits", &[("Authorization",format!("Bearer {token}"))],None) {
                Ok(result)=>{
                    let d=result.get("data").unwrap_or(&result);
                    let balance=match (d.get("total_credits").and_then(Value::as_f64),d.get("total_usage").and_then(Value::as_f64)) {
                        (Some(a),Some(b))=>Some(a-b),_=>None
                    };
                    json!({"status":"available","scope":"account","total_credits_usd":d.get("total_credits"),
                         "total_usage_usd":d.get("total_usage"),"balance_usd":balance})
                },Err(e)=>json!({"status":"unavailable","reason":e})
            },Err(_)=>json!({"status":"unavailable","reason":"configured_credential_unavailable"})
        };
    }
    json!({"source":"openrouter","key":key_info,"account":credits,"checked_at":now,
        "cost_scope_note":"Key and account totals are not per-period invocation charges and must not be added to usage ledger totals."})
}
fn repoql(c: &Config, path: &str) -> Result<Value, String> {
    let key = read_secret(&c.repoql_token)?;
    fetch_json(&format!("{}{}", c.repoql_base, path), &[("Authorization", format!("Bearer {key}"))], None)
}
fn inject_identity(action: &str, payload: &Value, key: &str) -> Value {
    // Upstream identity contract (proved live against the deployed core, 2026-10-26):
    // the /chat-memory/* panel routes resolve the caller from the x-tdai-* headers,
    // but the /meta/* core validation refuses a header-only identity and demands
    // "user_id or user_key" in the payload itself. Without the injection every
    // meta discovery call from the panel fails upstream with a 400 that the
    // gateway wraps as a 502. The server-side key is the only identity the panel
    // owns, so it is what gets injected; the injected value never reaches the
    // browser.
    //
    // Authorization rule (Sol turn 2, 2026-10-26): meta/team/list is the panel's
    // own discovery call — the upstream honors a bare payload user_id as an
    // identity SELECTOR there (live probe: another user's user_id returned that
    // user's team list), so caller-supplied user_key/user_id must not override the
    // configured server identity for THIS action. Other operations that carry
    // identity fields as target identifiers are untouched, and operator-authored
    // identity in other meta/* stays authoritative (never second-guessed).
    let mut body = payload.clone();
    let carries_identity = ["user_key", "user_id"].iter().any(|k| {
        payload.get(k).and_then(Value::as_str).map(|v| !v.trim().is_empty()).unwrap_or(false)
    });
    if body.is_object() {
        if action == "meta/team/list" {
            body["user_key"] = Value::String(key.to_string());
            if let Some(obj) = body.as_object_mut() { obj.remove("user_id"); }
        } else if action.starts_with("meta/") && !carries_identity {
            body["user_key"] = Value::String(key.to_string());
        }
    }
    body
}
fn ids_from_list(data: &Value, id_keys: &[&str], list_keys: &[&str]) -> Vec<String> {
    let rows: &[Value] = if let Some(a) = data.as_array() { a } else { selected(data, list_keys) };
    let mut out: Vec<String> = Vec::new();
    for r in rows {
        if let Some(id) = str_field(r, id_keys) {
            let id = id.trim();
            if !id.is_empty() && id.len() <= 256 && !id.contains(',') && !out.iter().any(|x| x == id) {out.push(id.to_string());}
        }
    }
    out
}
fn tencent(c: &Config, action: &str, payload: &Value) -> Result<Value, String> {
    if c.tencent_base.is_empty() || c.tencent_service.is_empty() {return Err("tencent_not_configured".into());}
    let key = read_secret(&c.tencent_key)?;
    let body = inject_identity(action, payload, &key);
    let headers = [("x-tdai-service-id", c.tencent_service.clone()), ("x-tdai-user-key", key)];
    let response = fetch_json(&format!("{}/api/v1/{}", c.tencent_base, action), &headers, Some(&body))?;
    if response.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!("tencent_{}", response.get("message").and_then(Value::as_str).unwrap_or("error")));
    }
    Ok(response.get("data").cloned().unwrap_or(Value::Null))
}
fn str_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| value.get(*k).and_then(Value::as_str))
}
fn selected<'a>(v: &'a Value, keys: &[&str]) -> &'a [Value] {
    for key in keys {if let Some(a) = v.get(*key).and_then(Value::as_array) { return a; }}
    &[]
}
fn node_id(system: &str, raw: &str) -> String {format!("{system}:{raw}")}
fn add_node(nodes: &mut HashMap<String, Value>, system: &str, raw: &str, label: &str, category: &str, canonical: Option<&str>) {
    if raw.is_empty() || raw.len() > 2048 {return;}
    let key = node_id(system, raw);
    nodes.entry(key.clone()).or_insert_with(|| json!({"id":key,"source_system":system,"source_id":raw,"label":label.chars().take(180).collect::<String>(),"category":category,"canonical_uri":canonical,"provenance": "source_api"}));
}
fn add_edge(edges: &mut Vec<Value>, system: &str, raw_from: &str, raw_to: &str, typ: &str, provenance: &str) {
    if raw_from.is_empty() || raw_to.is_empty() {return;}
    edges.push(json!({"id": format!("{}:{}:{}:{}",system,raw_from,typ,raw_to),"source":node_id(system,raw_from),"target":node_id(system,raw_to),"type":typ,"source_system":system,"provenance":provenance,"verified":true}));
}
// The hub documentation is the one corpus both systems name: RepoQL imports the documentation repository,
// and the wiki syncs every hub page as its sources/<slug> page, the slug made from the page's own path by
// the sync's rule (memory-hub-wiki-sync.py: drop a trailing .md, lowercase, / and spaces to -). A RepoQL
// file under the import and the wiki page of that slug are therefore the same document; a shared path is
// evidence, where a shared title never is.
// A Dockerhost-specific default would mix its documentation import with a fresh Windows graph.
// The Windows installation supplies the actual indexed prefix, or disables this join.
fn hub_doc_slug(rel_path: &str) -> Option<String> {
    let stem = rel_path.strip_suffix(".md")?;
    Some(stem.to_lowercase().replace('/', "-").replace(' ', "-"))
}
// The document slug a node is named by, for the two systems that hold the hub docs; None for any other
// node, an anchor suffix aside.
fn hub_doc_node_slug(node: &Value, prefix: &str) -> Option<String> {
    let raw = node["source_id"].as_str()?;
    if node["source_system"] == "repoql" {
        if prefix.is_empty() { return None; }
        hub_doc_slug(raw.split('#').next()?.strip_prefix(prefix)?)
    } else if node["source_system"] == "tencent" {
        raw.rsplit_once("/sources/").map(|(_, slug)| slug.to_owned())
    } else { None }
}
fn hub_document_join(nodes: &HashMap<String, Value>, edges: &mut Vec<Value>, prefix: &str) {
    let mut by_slug: HashMap<String, String> = HashMap::new();
    for (key, node) in nodes {
        if node["source_system"] != "repoql" { continue; }
        if let Some(slug) = hub_doc_node_slug(node, prefix) {
            // Two paths can slug alike; the lowest key wins so the pick does not depend on map order.
            match by_slug.get(&slug) {Some(existing) if existing <= key => {}, _ => {by_slug.insert(slug, key.clone());}}
        }
    }
    for (key, node) in nodes {
        if node["source_system"] != "tencent" { continue; }
        if let Some(slug) = hub_doc_node_slug(node, prefix) {
            if let Some(repoql) = by_slug.get(&slug) {
                edges.push(json!({"id":format!("hubdoc:{slug}"),"source":repoql,"target":key,"type":"SAME_SOURCE_DOCUMENT","source_system":"cross","provenance":"hub_document_path_matches_wiki_sources_page","verified":true}));
            }
        }
    }
}
// The memory import is the store's own memory, copied one file per memory by the memorycore connector.
// Its files carry no links, so they are never reachable through the link collections; the graph's
// Memories option adds them as their own source, one bounded ordered query on the dashboard.
const MEMORY_PREFIX: &str = "memorycore://data/";
fn stable_hash(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() { h ^= byte as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}
fn memory_category(uri: &str) -> &'static str {
    let rest = uri.strip_prefix(MEMORY_PREFIX).unwrap_or(uri);
    if rest.starts_with("records/") { "memory-record" }
    else if rest.starts_with("scenes/") { "memory-scene" }
    else if rest.starts_with("personas/") { "memory-persona" }
    else { "memory" }
}
// Each memory row becomes a Tencent node and a RepoQL document node sharing one canonical URI.
fn mirror_memories_as_tencent(data: &Value, nodes: &mut HashMap<String, Value>) -> usize {
    let mut n=0;
    for r in selected(data, &["rows"]) {
        let uri = match str_field(r, &["uri"]) { Some(v) => v, None => continue };
        let label = str_field(r, &["headline"]).map(str::trim).filter(|v| !v.is_empty())
            .or_else(|| str_field(r, &["name", "title"]).map(str::trim).filter(|v| !v.is_empty()))
            .unwrap_or(uri);
        let rest = uri.strip_prefix(MEMORY_PREFIX).unwrap_or(uri);
        let raw = format!("memorycore/{rest}");
        let before = nodes.len();
        add_node(nodes, "tencent", &raw, label, memory_category(uri), Some(uri));
        if let Some(t)=nodes.get_mut(&node_id("tencent", &raw)) { t["provenance"]=Value::String("memorycore_fallback".into()); }
        add_node(nodes, "repoql", uri, label, "document", Some(uri));
        if nodes.len()>before {n+=1;}
    }
    n
}
fn normalize_memory_rows(data: &Value, nodes: &mut HashMap<String, Value>) {
    for r in selected(data, &["rows"]) {
        let uri = match str_field(r, &["uri"]) { Some(v) => v, None => continue };
        let label = str_field(r, &["headline"]).map(str::trim).filter(|v| !v.is_empty())
            .or_else(|| str_field(r, &["name", "title"]).map(str::trim).filter(|v| !v.is_empty()))
            .unwrap_or(uri);
        add_node(nodes, "memories", uri, label, memory_category(uri), None);
    }
}
// Stable degree-aware sampling with source quotas, in two passes: first the endpoints of cross-system links,
// up to half of each side's quota, matched by the key both of their nodes share (the hub slug, or an
// identical canonical URI); then the degree order for the rest. Truncation by sorted node ID biased every
// bounded graph toward repoql and could hide Tencent, and a pure degree cut hides the cross links too,
// because their endpoints sit below it.
fn bounded_sample(mut all: Vec<Value>, edges: &[Value], limit: usize, prefix: &str) -> Vec<Value> {
    let mut degree:HashMap<String,usize>=HashMap::new();
    for e in edges {
        for field in ["source","target"] {
            if let Some(id)=e.get(field).and_then(Value::as_str) {
                *degree.entry(id.to_owned()).or_default()+=1;
            }
        }
    }
    all.sort_by(|a,b| {
        let da=a["id"].as_str().and_then(|k|degree.get(k)).copied().unwrap_or(0);
        let db=b["id"].as_str().and_then(|k|degree.get(k)).copied().unwrap_or(0);
        db.cmp(&da).then_with(||a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let rq=all.iter().filter(|n|n["source_system"]=="repoql").count();
    let tx=all.iter().filter(|n|n["source_system"]=="tencent").count();
    let mem=all.iter().filter(|n|n["source_system"]=="memories").count();
    let rq_quota=if tx>0 {rq.min(limit/2)} else {limit};
    let tx_quota=if rq>0 {tx.min(limit/2)} else {limit};
    // The Memories option is explicit, so it keeps up to a quarter of the viewport even while the two
    // wired systems carry all the degree; without it a pure degree cut would hide every memory node.
    let mut mem_reserve=if mem>0 {mem.min(limit/4)} else {0};
    let mut cross:HashSet<String>=HashSet::new();
    for e in edges {
        if e["source_system"]!="cross" {continue;}
        for field in ["source","target"] {
            if let Some(id)=e.get(field).and_then(Value::as_str) {cross.insert(id.to_owned());}
        }
    }
    // A pair is kept whole: both of its endpoints carry the same reserve key, and both sides walk the keys
    // in the same order — the key alone, never the degree, which the two endpoints of one link need not
    // share — so an equal cap on each side cuts at the same pair.
    let mut reserve:Vec<(String,usize)>=Vec::new();
    for (i,n) in all.iter().enumerate() {
        let id=match n["id"].as_str() {Some(v)=>v,None=>continue};
        if !cross.contains(id) {continue;}
        let key=match hub_doc_node_slug(n, prefix).or_else(||n["canonical_uri"].as_str().filter(|u|!u.is_empty()).map(|u|format!("canonical:{u}"))) {Some(v)=>v,None=>continue};
        reserve.push((key,i));
    }
    reserve.sort_by(|a,b|a.0.cmp(&b.0).then_with(||a.1.cmp(&b.1)));
    let mut picked=Vec::new();let mut selected=HashSet::new();
    let mut count_rq=0;let mut count_tx=0;
    for (_,i) in reserve {
        let n=&all[i];
        let system=n["source_system"].as_str().unwrap_or("");
        if !(if system=="repoql" {count_rq<rq_quota/2} else if system=="tencent" {count_tx<tx_quota/2} else {false}) {continue;}
        if system=="repoql" {count_rq+=1;} else {count_tx+=1;}
        if let Some(id)=n["id"].as_str(){selected.insert(id.to_string());}
        picked.push(n.clone());
    }
    // Spread the memories reserve across the whole corpus: id order would always show the same
    // earliest memories for one memorycore import, which grows day by day.
    let mut mem_pick:Vec<&Value>=all.iter().filter(|n|n["source_system"]=="memories").collect();
    mem_pick.sort_by_key(|n|stable_hash(n["id"].as_str().unwrap_or("")));
    for n in mem_pick {
        if picked.len()>=limit || mem_reserve==0 {break;}
        let id=match n["id"].as_str() {Some(v)=>v,None=>continue};
        if selected.insert(id.to_string()) {picked.push(n.clone());mem_reserve-=1;}
    }
    for n in &all {
        if picked.len()>=limit {break;}
        let id=n["id"].as_str().unwrap_or("");
        if selected.contains(id) {continue;}
        let system=n["source_system"].as_str().unwrap_or("");
        if system=="memories" {continue;} // they carry their own reserve; the final fill pass tops them up
        if (system=="repoql" && count_rq>=rq_quota)||(system=="tencent" && count_tx>=tx_quota) {continue;}
        if system=="repoql" {count_rq+=1;} else if system=="tencent" {count_tx+=1;}
        selected.insert(id.to_string());
        picked.push(n.clone());
    }
    // Whatever the quota pass leaves is filled from the wired systems first, and only then from the
    // memories: at limits below four the memories reserve is zero (integer division), and a plain
    // pass over the sorted list would still hand those slots to memories, whose ids sort early.
    for only_memories in [false, true] {
        for n in &all {
            if picked.len()>=limit{break;}
            if (n["source_system"]=="memories")!=only_memories {continue;}
            let id=n["id"].as_str().unwrap_or("");
            if selected.insert(id.to_string()){picked.push(n.clone());}
        }
    }
    picked
}
fn normalize_repoql(data: &Value, nodes: &mut HashMap<String, Value>, edges: &mut Vec<Value>) {
    for r in selected(data, &["rows"]) {
        if r.get("resolved")==Some(&Value::Bool(false)) {continue;}
        let from = str_field(r, &["source_uri"]); let to = str_field(r, &["target_uri", "destination_uri"]);
        if let (Some(from),Some(to))=(from,to) {
            add_node(nodes,"repoql",from,str_field(r,&["source_name"]).unwrap_or(from),str_field(r,&["source_category"]).unwrap_or("document"),Some(from));
            add_node(nodes,"repoql",to,str_field(r,&["target_name"]).unwrap_or(to),str_field(r,&["target_category"]).unwrap_or("document"),Some(to));
            add_edge(edges,"repoql",from,to,str_field(r,&["type"]).unwrap_or("SEE_ALSO"),str_field(r,&["provenance"]).unwrap_or("repoql_api"));
        }
    }
}
fn edge_endpoint<'a>(value: Option<&'a Value>) -> Option<&'a str> {
    value.and_then(|x| x.as_str().or_else(|| str_field(x,&["id", "node_id"])))
}
fn normalize_tencent(graph: &Value, wiki_id: &str, nodes: &mut HashMap<String, Value>, edges: &mut Vec<Value>) {
    let graph = graph.get("graph").unwrap_or(graph);
    for n in selected(graph, &["nodes","vertices","entities"]) {
        if let Some(raw) = str_field(n,&["id","node_id","uri","key"]) {
            let canonical = str_field(n,&["canonical_uri","source_uri"]);
            add_node(nodes,"tencent",&format!("{wiki_id}/{raw}"),str_field(n,&["name","label","title"]).unwrap_or(raw),str_field(n,&["type","category"]).unwrap_or("memory"),canonical);
        }
    }
    for e in selected(graph,&["edges","links","relations"]) {
        let from=edge_endpoint(e.get("source").or_else(||e.get("from")));
        let to=edge_endpoint(e.get("target").or_else(||e.get("to")));
        if let (Some(from),Some(to))=(from,to) {
            // Preserve endpoint-only nodes if the Tencent graph omits the nodes collection.
            add_node(nodes,"tencent",&format!("{wiki_id}/{from}"),from,"memory",None);
            add_node(nodes,"tencent",&format!("{wiki_id}/{to}"),to,"memory",None);
            add_edge(edges,"tencent",&format!("{wiki_id}/{from}"),&format!("{wiki_id}/{to}"),str_field(e,&["type","relation","label"]).unwrap_or("RELATED"),"tencent_wiki_graph");
        }
    }
}
fn graph(c: &Config, query: &HashMap<String,String>) -> Value {
    let limit = query.get("limit").and_then(|v|v.parse::<usize>().ok()).unwrap_or(500).clamp(10, 1500);
    let search=query.get("q").cloned().unwrap_or_default().to_lowercase();
    let mut nodes=HashMap::new(); let mut edges=Vec::new(); let mut sources=Vec::new();
    if query.get("repoql").map(|v|v!="false").unwrap_or(true) {
        let mut received=0usize;let mut error=None;
        for collection in ["see_also", "refers_to", "composition"] {
            for page in 1..=4 {
                let path=format!("/api/links?collection={collection}&page={page}&page_size=200&counts=false");
                match repoql(c,&path) {
                    Ok(data) => {let n=selected(&data,&["rows"]).len();normalize_repoql(&data,&mut nodes,&mut edges);received+=n;if n<200 || nodes.len()>=limit*2 {break;}},
                    Err(e) => {error=Some(e);break;}
                }
            }
            if error.is_some() || nodes.len()>=limit*2 {break;}
        }
        // The join below can only fire when both sides of a hub document are present, and whole documents
        // sit far below the degree cut. The import's own rows come from one bounded, ordered query on the
        // dashboard, built for this join: paging the shared /api/links collection took 19 requests per
        // graph build and, unordered, saw a different subset each run (measured 2026-10-27). The call runs
        // only while the wiki is part of this request, and a failure is reported in the sources entry, so
        // a zero can never pass for rows that were never fetched.
        let mut hub_rows=0usize;let mut hub_truncated=false;let mut hub_error=None;
        if !c.hub_doc_prefix.is_empty() && !c.wiki_ids.is_empty() && query.get("tencent").map(|v|v!="false").unwrap_or(true) {
            let path=format!("/api/hub-doc-rows?prefix={}",url::form_urlencoded::byte_serialize(c.hub_doc_prefix.as_bytes()).collect::<String>());
            match repoql(c,&path) {
                Ok(data) => {hub_rows=selected(&data,&["rows"]).len();hub_truncated=data.get("total").and_then(Value::as_u64).map(|total|total as usize>hub_rows).unwrap_or(false);normalize_repoql(&data,&mut nodes,&mut edges);},
                Err(e) => {hub_error=Some(e);},
            }
        }
        // The memory import is asked for only while its own option is on: thousands of linkless files
        // would otherwise swamp a bounded graph, and the option is the operator's explicit choice. One
        // bounded, ordered query; a failure is reported in the sources entry, so a zero can never pass
        // for rows that were never fetched.
        let mut memory_rows = 0usize;
        let mut memory_error = None;
        if query.get("memories").map(|v|v=="true"||v=="1").unwrap_or(false) {
            let path=format!("/api/memory-docs?prefix={}",MEMORY_PREFIX);
            match repoql(c,&path) {
                Ok(data) => {memory_rows=selected(&data,&["rows"]).len();normalize_memory_rows(&data,&mut nodes);},
                Err(e) => {memory_error=Some(e);},
            }
            let available=memory_error.is_none();
            sources.push(json!({"name":"memories","available":available,"rows":memory_rows,"error":memory_error}));
        }
        sources.push(json!({"name":"repoql","available":error.is_none(),"error":error,"received_rows":received,"hub_document_rows":hub_rows,"hub_document_truncated":hub_truncated,"hub_document_error":hub_error}));
    }
    if query.get("tencent").map(|v|v!="false").unwrap_or(true) {
        let mut count=0; let mut errors=Vec::new();
        // Setup installs no explicit wiki ids: discover this identity's own wikis through the
        // read-only list action instead of reporting a permanently empty graph source.
        let mut discovered: Vec<(String,Option<String>)> = Vec::new();
        if c.wiki_ids.is_empty() {
            // The panel scopes wikis by team: list this identity's teams first, then each team's wikis.
            match tencent(c,"meta/team/list",&json!({})) {
                Ok(data) => for team in ids_from_list(&data,&["team_id","id"],&["teams","items","list","rows","data"]).into_iter().take(10) {
                    match tencent(c,"knowledge/wiki/list",&json!({"team_id":team})) {
                        Ok(w) => for id in ids_from_list(&w,&["wiki_id","id"],&["wikis","items","list","rows","data"]) {
                            if !discovered.iter().any(|(x,_)| *x==id) {discovered.push((id,Some(team.clone())));}
                        },
                        Err(e) => errors.push(format!("wiki_list: {e}")),
                    }
                },
                Err(e) => errors.push(format!("team_list: {e}")),
            }
        }
        let targets: Vec<(String,Option<String>)> = if c.wiki_ids.is_empty() { discovered } else { c.wiki_ids.iter().map(|w|(w.clone(),None)).collect() };
        for (wiki_id,team) in targets.iter().take(10) {
            let mut payload=json!({"wiki_id":wiki_id});
            if let Some(t)=team {payload["team_id"]=Value::String(t.clone());}
            match tencent(c,"knowledge/wiki/graph",&payload) {
                Ok(g) => {normalize_tencent(&g,wiki_id,&mut nodes,&mut edges);count+=1;},
                Err(e) => errors.push(format!("{wiki_id}: {e}"))
            }
        }
        sources.push(json!({"name":"tencent","available":count>0,"wiki_count":count,"error":if targets.is_empty() && errors.is_empty(){vec!["no_wikis_for_identity".to_owned()]}else{errors}}));
    }
    // Fallback for an install whose wiki has no graph yet (the wiki graph is built by an LLM ingest that
    // needs a configured key): MemoryCore's own memories are the Tencent-side data every Windows install
    // has. Show them as Tencent nodes; RepoQL indexes the same memorycore:// documents, so each one is
    // paired with its RepoQL document node by the identical canonical URI below. Marked in provenance.
    if query.get("tencent").map(|v|v!="false").unwrap_or(true) && !nodes.values().any(|n|n["source_system"]=="tencent") {
        let path=format!("/api/memory-docs?prefix={}",MEMORY_PREFIX);
        match repoql(c,&path) {
            Ok(data) => {
                let n=mirror_memories_as_tencent(&data,&mut nodes);
                sources.push(json!({"name":"tencent_memory_fallback","available":true,"rows":n,"error":null}));
            },
            Err(e) => sources.push(json!({"name":"tencent_memory_fallback","available":false,"rows":0,"error":e})),
        }
    }
    // Cross-system edges require identical explicit source URI evidence; never infer from a label.
    let mut by_uri: HashMap<String, Vec<String>>=HashMap::new();
    for (key,node) in &nodes {if let Some(uri)=node.get("canonical_uri").and_then(Value::as_str) {if !uri.is_empty() {by_uri.entry(uri.to_string()).or_default().push(key.clone());}}}
    for (uri, ids) in by_uri {let rq=ids.iter().find(|x|x.starts_with("repoql:")); let tx=ids.iter().find(|x|x.starts_with("tencent:"));
        if let (Some(a),Some(b))=(rq,tx) {edges.push(json!({"id":format!("match:{uri}"),"source":a,"target":b,"type":"SAME_CANONICAL_URI","source_system":"cross","provenance":"identical_explicit_canonical_uri","verified":true}));}}
    // And the hub documents, named by both systems under one slug rule, become cross links too.
    hub_document_join(&nodes, &mut edges, &c.hub_doc_prefix);
    let mut all: Vec<Value>=nodes.into_values().collect();all.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));
    if !search.is_empty() {
        let matches: HashSet<String>=all.iter().filter(|n|["label","source_id","category"].iter().any(|k|n.get(*k).and_then(Value::as_str).unwrap_or("").to_lowercase().contains(&search))).filter_map(|n|n["id"].as_str().map(str::to_owned)).collect();
        // Include one-hop neighbors, but do not expand to unrelated components.
        let mut selected_ids=matches;
        for e in &edges {let a=e["source"].as_str().unwrap_or("");let b=e["target"].as_str().unwrap_or("");if selected_ids.contains(a){selected_ids.insert(b.to_owned());} if selected_ids.contains(b){selected_ids.insert(a.to_owned());}}
        all.retain(|n|n["id"].as_str().map(|id|selected_ids.contains(id)).unwrap_or(false));
    }
    let total=all.len();
    if total>limit {all=bounded_sample(all,&edges,limit,&c.hub_doc_prefix);}
    all.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));
    let ids: HashSet<String>=all.iter().filter_map(|v|v["id"].as_str().map(str::to_owned)).collect();
    edges.retain(|e|e["source"].as_str().map(|s|ids.contains(s)).unwrap_or(false) && e["target"].as_str().map(|s|ids.contains(s)).unwrap_or(false));
    edges.truncate(limit*4);
    json!({"schema":"unified-graph/1","nodes":all,"edges":edges,"total_before_limit":total,"truncated":total>limit,"sources":sources,"retrieved_at":Utc::now().to_rfc3339(),"refresh_policy":"bounded_poll"})
}
fn readonly_action(action: &str) -> bool {
    let verb=action.rsplit('/').next().unwrap_or("");
    matches!(verb,"list"|"get"|"read"|"search"|"graph"|"ls"|"explore"|"versions"|"listing"|"verify"|"bootstrap"|"team-assets"|"my-agents"|"agent-fixed"|"mine"|"layer"|"list-with-agents"|"check"|"summary-by-agents"|"quota"|"files/read")
        || action == "agent-overview/bootstrap"
}
fn catalog() -> Value {
    let mut entries=Vec::new();
    let groups: &[(&str,&[&str])] = &[
        ("meta/user", &["create","create-with-key","get","delete","list"]),
        ("meta/user-key", &["create","list","get","revoke","update"]),
        ("meta/team", &["create","get","update","delete","list"]),
        ("meta/team-member", &["add","remove","list","get"]),
        ("meta/agent", &["create","get","update","delete","list","archive","set-default-template","get-default-template"]),
        ("meta/task", &["create","get","update","delete","list","archive"]),
        ("meta/task-agent", &["link","unlink","list"]),
        ("meta/participation-log", &["append","list"]),
        ("meta/asset", &["create","get","update","delete","list","list-accessible","touch-usage"]),
        ("meta/acl", &["grant","revoke","list","check"]),
        ("meta/instance-quota", &["get"]),
        ("meta/config/user", &["get","set"]),
        ("skill", &["create","update","patch","delete","get","list","search","versions","files/write","files/remove","files/read","listing","extract","export","conversation/add"]),
        ("chat-memory", &["team-assets","agent-fixed","my-agents","mine","create","import","patch-scope","set-agent-fixed","allocate","unbind","layer","clear","layer-delete","layer-update","search"]),
        ("knowledge/wiki", &["list","create","get","delete","graph","page/ls","page/read","page/rm","search","raw/ls","raw/read","team-assets","sync"]),
        ("knowledge/code-graph", &["list","create","register-meta","get","sync","delete","search","explore","team-assets"]),
        ("knowledge", &["allocate","unbind","list-allocations","grant","revoke"]),
        ("task", &["list-with-agents"]),
        ("agent-overview", &["bootstrap"]),
        ("agent", &["delete-cascade"]),
    ];
    for (group,verbs) in groups {
        for verb in *verbs {let operation=format!("{group}/{verb}");entries.push(json!({"operation":operation,"group":group,"readonly":readonly_action(&operation)}));}
    }
    json!({"operations":entries,"version":"upstream_panel_api_reference","disclaimer":"Validate each action against deployed Tencent version; unsupported actions return upstream errors"})
}
fn invoke(c: &Config, value: &Value) -> Result<Value, (u16,String)> {
    let action=value.get("operation").and_then(Value::as_str).ok_or((400,"missing_operation".to_string()))?;
    let allow=catalog()["operations"].as_array().unwrap().iter().any(|a|a["operation"].as_str()==Some(action));
    if !allow {return Err((404,"operation_not_allowlisted".into()));}
    if !readonly_action(action) {
        if !c.writes {return Err((403,"tencent_writes_disabled".into()));}
        if value.get("confirm").and_then(Value::as_str)!=Some("APPLY TENCENT CHANGE") {return Err((403,"explicit_confirmation_required".into()));}
    }
    let payload=value.get("payload").ok_or((400,"missing_payload".into()))?;
    if !payload.is_object() {return Err((400,"payload_must_be_object".into()));}
    if !readonly_action(action) { eprintln!("tencent_mutation_started action={action} at={}",Utc::now().to_rfc3339()); }
    let result=tencent(c,action,payload).map_err(|e|(502,e));
    if !readonly_action(action) { eprintln!("tencent_mutation_finished action={action} result={} at={}",if result.is_ok(){"ok"}else{"error"},Utc::now().to_rfc3339()); }
    result
}
fn get_num(v: &Value, key: &str)-> Option<u64>{v.get(key).and_then(Value::as_u64)}
fn fresh_input(input: Option<u64>, cached: Option<u64>) -> Option<u64> {
    match (input, cached) {
        (Some(input), Some(cached)) => Some(input.saturating_sub(cached)),
        _ => None,
    }
}

fn filter_value<'a>(value: Option<&'a String>) -> Option<&'a str> {
    value.map(String::as_str).map(str::trim)
        .filter(|v| !v.is_empty() && *v != "all")
}

fn fb_host_key(id: &str) -> &str { id.strip_prefix("freebuff-").unwrap_or(id) }

fn matches_filter(v: &Value, host: Option<&str>, model: Option<&str>) -> bool {
    let host_ok = host.map(|h| v.get("host").and_then(Value::as_str) == Some(h)).unwrap_or(true);
    let model_ok = model.map(|m| v.get("model").and_then(Value::as_str) == Some(m)).unwrap_or(true);
    host_ok && model_ok
}

fn opt_sum(sum: u64, count: u64) -> Option<u64> {
    if count > 0 { Some(sum) } else { None }
}

/// Filtered Freebuff aggregate computed over every matching event, so a
/// truncated event sample can never turn into a truncated total.
#[derive(Default)]
struct FbFilter {
    events: u64,
    input: u64,
    input_events: u64,
    cached: u64,
    cached_events: u64,
    fresh: u64,
    fresh_events: u64,
    output: u64,
    output_events: u64,
    reasoning: u64,
    reasoning_events: u64,
    total: u64,
    total_events: u64,
    incomplete: u64,
    exact_input: u64,
    exact_input_events: u64,
    exact_output: u64,
    exact_output_events: u64,
    daily: BTreeMap<String, (u64, u64, u64, u64, u64)>,
}

#[derive(Default)]
struct FbModel {
    events: u64,
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
}

#[derive(Default)]
struct FbHost {
    label: String,
    status: String,
    events: u64,
    input: u64,
    cached: u64,
    fresh: u64,
    fresh_events: u64,
    output: u64,
    reasoning: u64,
    total: u64,
    incomplete: u64,
    latest: Option<String>,
    account: Option<String>,
    models: BTreeMap<String, FbModel>,
}

fn usage(c: &Config, query: &HashMap<String, String>) -> Value {
    let since = match query.get("days").and_then(|s| s.parse::<i64>().ok()) {
        Some(n) => n.clamp(1, 365),
        None => 30,
    };
    let cutoff = Utc::now() - chrono::Duration::days(since);
    let mut source_reports = Vec::new();
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut total_cached = 0u64;
    let mut total_fresh = 0u64;
    let mut total_reasoning = 0u64;
    let mut total_tokens = 0u64;
    let mut actual = 0f64;
    let mut estimated = 0f64;
    let mut actual_count = 0u64;
    let mut estimated_count = 0u64;
    let mut all_events = 0u64;
    let mut in_count = 0u64;
    let mut out_count = 0u64;
    let mut cached_count = 0u64;
    let mut fresh_count = 0u64;
    let mut reasoning_count = 0u64;
    let mut tokens_count = 0u64;
    let mut incomplete_events = 0u64;
    let mut exact_in = 0u64;
    let mut exact_out = 0u64;
    let mut exact_in_count = 0u64;
    let mut exact_out_count = 0u64;
    let mut dedup = HashSet::new();
    let mut recent = Vec::<Value>::new();
    let mut fb_hosts: BTreeMap<String, FbHost> = BTreeMap::new();
    let mut fb_events = Vec::<Value>::new();
    let mut fb_incomplete = 0u64;
    let mut fb_events_total = 0u64;
    let host_filter = filter_value(query.get("host"));
    let model_filter = filter_value(query.get("model"));
    let mut fb_filter = FbFilter::default();
    // Aggregates are formed from ALL validated and deduplicated events, not the
    // 100 recent rows. Count fields distinguish genuinely reported zero from a
    // missing measurement.
    let mut daily: BTreeMap<String, (u64, u64, u64, u64, f64, u64)> = BTreeMap::new();
    for (source, label) in SOURCES {
        let is_freebuff = source.starts_with("freebuff");
        if is_freebuff {
            fb_hosts.entry(source.to_string()).or_insert_with(|| FbHost {
                label: label.to_string(),
                ..Default::default()
            });
        }
        let path = c.usage_dir.join(format!("{source}.jsonl"));
        let mut events = 0u64;
        let mut malformed = 0u64;
        let mut latest = None::<String>;
        let mut last_run_at = None::<String>;
        let mut newest_token_at = None::<DateTime<Utc>>;
        let mut quota_windows = std::collections::BTreeMap::<String, Value>::new();
        let mut source_recent = Vec::<Value>::new();
        // Check metadata before allocating the complete JSONL file.
        let oversize = fs::metadata(&path).map(|m| m.len() > MAX_USAGE_FILE_BYTES as u64).unwrap_or(false);
        // Unconfigured Windows usage does not read a relative file in the
        // scheduled task working directory or inherit Dockerhost collectors.
        let file = if oversize || c.usage_dir.as_os_str().is_empty() {None} else {fs::read_to_string(&path).ok()};
        let mut file_status = "available";
        if oversize {
            file_status = "oversize";
        } else if let Some(lines) = &file {
            if lines.len() > MAX_USAGE_FILE_BYTES {
                file_status = "oversize";
            } else if lines.lines().count() > MAX_USAGE_ROWS {
                // Fail the complete source rather than silently publish partial totals.
                file_status = "row_limit";
            } else {
                for line in lines.lines() {
                    let v: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(_) => {
                            malformed += 1;
                            continue;
                        }
                    };
                    let timestamp = match v["timestamp"].as_str() {
                        Some(s) => s,
                        None => {
                            malformed += 1;
                            continue;
                        }
                    };
                    let ts: DateTime<Utc> = match DateTime::parse_from_rfc3339(timestamp) {
                        Ok(t) => t.with_timezone(&Utc),
                        Err(_) => {
                            malformed += 1;
                            continue;
                        }
                    };
                    if last_run_at.as_ref().map(|x| timestamp > x.as_str()).unwrap_or(true) {
                        last_run_at = Some(timestamp.to_owned());
                    }
                    if ts > Utc::now() + chrono::Duration::minutes(5) {
                        continue;
                    }
                    // Staleness judges the newest valid token record over the whole file,
                    // independent of the requested read window.
                    // Any measured usage counts: tokens, or reported/estimated spend (OpenRouter rows carry spend only).
                    // Subscription quota snapshots carry utilization, not tokens; they count as measured.
                    let is_quota = v["metric_type"].as_str() == Some("subscription_quota");
                    if is_quota && v["utilization_percent"].is_number() {
                        quota_windows.insert(v["window_type"].as_str().unwrap_or("").to_owned(), v.clone());
                    }
                    let has_tokens = is_quota || v["input_tokens"].is_number() || v["output_tokens"].is_number()
                        || v["reported_spend_usd"].is_number() || v["estimated_api_value_usd"].is_number();
                    if has_tokens && newest_token_at.map(|x| ts > x).unwrap_or(true) {
                        newest_token_at = Some(ts);
                    }
                    if ts < cutoff {
                        continue;
                    }
                    let event_id = match v["event_id"].as_str() {
                        Some(id) if !id.is_empty() => id,
                        _ => {
                            malformed += 1;
                            continue;
                        }
                    };
                    // A globally stable event ID prevents double counting across
                    // files, hosts and repeated collector runs.
                    if !dedup.insert(event_id.to_owned()) {
                        continue;
                    }
                    events += 1;
                    all_events += 1;
                    let inp = get_num(&v, "input_tokens");
                    let out = get_num(&v, "output_tokens");
                    let cached = get_num(&v, "cached_input_tokens");
                    let reasoning = get_num(&v, "reasoning_tokens");
                    let fresh = fresh_input(inp, cached);
                    let canonical_total = match (inp, out) {
                        (Some(i), Some(o)) => Some(i.saturating_add(o)),
                        _ => None,
                    };
                    let incomplete = v["usage_incomplete"].as_bool().unwrap_or(false);
                    if incomplete {
                        incomplete_events += 1;
                    } else {
                        if let Some(i) = inp {
                            exact_in = exact_in.saturating_add(i);
                            exact_in_count += 1;
                        }
                        if let Some(o) = out {
                            exact_out = exact_out.saturating_add(o);
                            exact_out_count += 1;
                        }
                    }
                    let day = ts.format("%Y-%m-%d").to_string();
                    let bucket = daily.entry(day).or_insert((0, 0, 0, 0, 0.0, 0));
                    if let Some(n) = inp {
                        bucket.0 = bucket.0.saturating_add(n);
                        bucket.2 += 1;
                        total_in = total_in.saturating_add(n);
                        in_count += 1;
                    }
                    if let Some(n) = out {
                        bucket.1 = bucket.1.saturating_add(n);
                        bucket.3 += 1;
                        total_out = total_out.saturating_add(n);
                        out_count += 1;
                    }
                    if let Some(n) = cached {
                        total_cached = total_cached.saturating_add(n);
                        cached_count += 1;
                    }
                    if let Some(n) = fresh {
                        total_fresh = total_fresh.saturating_add(n);
                        fresh_count += 1;
                    }
                    if let Some(n) = reasoning {
                        total_reasoning = total_reasoning.saturating_add(n);
                        reasoning_count += 1;
                    }
                    if let Some(n) = canonical_total {
                        total_tokens = total_tokens.saturating_add(n);
                        tokens_count += 1;
                    }
                    if let Some(n) = v["reported_spend_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0) {
                        bucket.4 += n;
                        bucket.5 += 1;
                        actual += n;
                        actual_count += 1;
                    }
                    if let Some(n) = v["estimated_api_value_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0) {
                        estimated += n;
                        estimated_count += 1;
                    }
                    if latest.as_ref().map(|x| timestamp > x.as_str()).unwrap_or(true) {
                        latest = Some(timestamp.to_owned());
                    }
                    source_recent.push(json!({
                        "timestamp": timestamp, "source": source,
                        "provider": v.get("provider"), "model": v.get("model"),
                        "host": v.get("host"), "input_tokens": inp,
                        "cached_input_tokens": cached, "fresh_input_tokens": fresh,
                        "output_tokens": out, "reasoning_tokens": reasoning,
                        "total_tokens": canonical_total, "usage_incomplete": incomplete,
                        "billing_class": v.get("billing_class"),
                        "provenance": v.get("provenance"),
                        "reported_spend_usd": v.get("reported_spend_usd"),
                    }));
                    if source_recent.len() > 200 {
                        source_recent.sort_by(|a, b| b["timestamp"].as_str().cmp(&a["timestamp"].as_str()));
                        source_recent.truncate(100);
                    }
                    if is_freebuff {
                        // The event sample and the filtered totals follow the host/model
                        // query, but the coverage block below always covers every event so
                        // filters cannot hide a host or make its counters look complete.
                        if matches_filter(&v, host_filter, model_filter) {
                            fb_events_total += 1;
                            if incomplete { fb_incomplete += 1; }
                            fb_filter.events += 1;
                            if let Some(n) = inp {
                                fb_filter.input = fb_filter.input.saturating_add(n);
                                fb_filter.input_events += 1;
                            }
                            if let Some(n) = cached {
                                fb_filter.cached = fb_filter.cached.saturating_add(n);
                                fb_filter.cached_events += 1;
                            }
                            if let Some(n) = fresh {
                                fb_filter.fresh = fb_filter.fresh.saturating_add(n);
                                fb_filter.fresh_events += 1;
                            }
                            if let Some(n) = out {
                                fb_filter.output = fb_filter.output.saturating_add(n);
                                fb_filter.output_events += 1;
                            }
                            if let Some(n) = reasoning {
                                fb_filter.reasoning = fb_filter.reasoning.saturating_add(n);
                                fb_filter.reasoning_events += 1;
                            }
                            if let Some(n) = canonical_total {
                                fb_filter.total = fb_filter.total.saturating_add(n);
                                fb_filter.total_events += 1;
                            }
                            if incomplete {
                                fb_filter.incomplete += 1;
                            } else {
                                if let Some(n) = inp {
                                    fb_filter.exact_input = fb_filter.exact_input.saturating_add(n);
                                    fb_filter.exact_input_events += 1;
                                }
                                if let Some(n) = out {
                                    fb_filter.exact_output = fb_filter.exact_output.saturating_add(n);
                                    fb_filter.exact_output_events += 1;
                                }
                            }
                            let day = ts.format("%Y-%m-%d").to_string();
                            let bucket = fb_filter.daily.entry(day).or_insert((0, 0, 0, 0, 0));
                            if let Some(n) = inp { bucket.0 = bucket.0.saturating_add(n); bucket.3 += 1; }
                            if let Some(n) = fresh { bucket.1 = bucket.1.saturating_add(n); }
                            if let Some(n) = out { bucket.2 = bucket.2.saturating_add(n); bucket.4 += 1; }
                            fb_events.push(json!({
                                "timestamp": timestamp, "source": source,
                                "host": v.get("host"), "account_ref": v.get("account_ref"),
                                "model": v.get("model"), "model_source": v.get("model_source"),
                                "run_id": v.get("run_id"), "session_id": v.get("session_id"),
                                "input_tokens": inp, "cached_input_tokens": cached,
                                "fresh_input_tokens": fresh, "output_tokens": out,
                                "reasoning_tokens": reasoning, "total_tokens": canonical_total,
                                "usage_incomplete": incomplete,
                                "billing_class": v.get("billing_class"),
                                "provenance": v.get("provenance"),
                            }));
                        }
                        if let Some(host) = fb_hosts.get_mut(source) {
                            host.events += 1;
                            if let Some(n) = inp { host.input = host.input.saturating_add(n); }
                            if let Some(n) = cached { host.cached = host.cached.saturating_add(n); }
                            if let Some(n) = fresh {
                                host.fresh = host.fresh.saturating_add(n);
                                host.fresh_events += 1;
                            }
                            if let Some(n) = out { host.output = host.output.saturating_add(n); }
                            if let Some(n) = reasoning { host.reasoning = host.reasoning.saturating_add(n); }
                            if let Some(n) = canonical_total { host.total = host.total.saturating_add(n); }
                            if incomplete { host.incomplete += 1; }
                            if host.account.is_none() {
                                host.account = v["account_ref"].as_str().map(str::to_owned);
                            }
                            if host.latest.as_ref().map(|x| timestamp > x.as_str()).unwrap_or(true) {
                                host.latest = Some(timestamp.to_owned());
                            }
                            let model = v["model"].as_str().unwrap_or("unknown").to_owned();
                            let entry = host.models.entry(model).or_default();
                            entry.events += 1;
                            if let Some(n) = inp { entry.input = entry.input.saturating_add(n); }
                            if let Some(n) = cached { entry.cached = entry.cached.saturating_add(n); }
                            if let Some(n) = out { entry.output = entry.output.saturating_add(n); }
                            if let Some(n) = reasoning { entry.reasoning = entry.reasoning.saturating_add(n); }
                        }
                    }
                }
            }
        } else {
            file_status = "unavailable";
        }
        source_recent.sort_by(|a, b| b["timestamp"].as_str().cmp(&a["timestamp"].as_str()));
        source_recent.truncate(100);
        recent.extend(source_recent);
        // Four cases: no file; zero valid token rows; stale valid token rows; fresh.
        // Run-activity rows without token data never count as measured usage.
        let is_stale = newest_token_at
            .map(|t| (Utc::now() - t).num_seconds() > SOURCE_STALE_SECONDS)
            .unwrap_or(false);
        let newest_quota_at = quota_windows.values()
            .filter_map(|v| v["timestamp"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()))
            .map(|t| t.with_timezone(&Utc))
            .max();
        let quota_stale = newest_quota_at
            .map(|t| (Utc::now() - t).num_seconds() > QUOTA_STALE_SECONDS)
            .unwrap_or(false);
        let status = if file_status != "available" {
            file_status
        } else if newest_token_at.is_none() {
            "no_token_data"
        } else if is_stale || quota_stale {
            "stale"
        } else if malformed > 0 {
            "partial"
        } else {
            "available"
        };
        if is_freebuff {
            if let Some(host) = fb_hosts.get_mut(source) {
                host.status = status.to_string();
            }
        }
        source_reports.push(json!({
            "id": source, "label": label, "status": status, "events": events,
            "invalid_rows": malformed, "latest_at": latest, "last_run_at": last_run_at,
            "quota_windows": quota_windows.values().cloned().collect::<Vec<Value>>(),
            "reason": match status {
                "oversize" => Some("Usage file exceeds bounded reader limit"),
                "row_limit" => Some("Usage file exceeds bounded row limit"),
                "unavailable" => Some("No current JSONL from this source"),
                "stale" => Some("Newest receipt is older than the staleness window"),
                "no_token_data" => Some("Source has run records but no valid token usage; not measured usage"),
                "partial" => Some("Malformed rows excluded"),
                _ => None,
            },
            "account_ref": if is_freebuff { fb_hosts.get(source).and_then(|h| h.account.clone()) } else { None },
        }));
    }
    recent.sort_by(|a, b| b["timestamp"].as_str().cmp(&a["timestamp"].as_str()));
    recent.truncate(100);
    fb_events.sort_by(|a, b| a["timestamp"].as_str().cmp(&b["timestamp"].as_str()));
    let truncated = fb_events.len() > 5_000;
    if truncated {
        let drop = fb_events.len() - 5_000;
        fb_events.drain(0..drop);
    }
    let fb_host_rows: Vec<Value> = fb_hosts
        .into_iter()
        .map(|(id, h)| {
            let models: Vec<Value> = h
                .models
                .into_iter()
                .map(|(model, m)| json!({
                    "model": model, "events": m.events, "input_tokens": m.input,
                    "cached_input_tokens": m.cached, "output_tokens": m.output,
                    "reasoning_tokens": m.reasoning,
                }))
                .collect();
            json!({
                "id": id, "host": fb_host_key(&id), "label": h.label, "status": h.status, "events": h.events,
                "account_ref": h.account, "input_tokens": h.input,
                "cached_input_tokens": h.cached, "fresh_input_tokens": h.fresh,
                "fresh_token_events": h.fresh_events, "output_tokens": h.output,
                "reasoning_tokens": h.reasoning, "total_tokens": h.total,
                "incomplete_events": h.incomplete, "latest_at": h.latest,
                "models": models,
            })
        })
        .collect();
    let fb_filtered_daily: Vec<Value> = fb_filter.daily.iter()
        .map(|(day, (tin, tfresh, tout, nin, nout))| json!({
            "day": day,
            "input_tokens": if *nin > 0 { Some(*tin) } else { None::<u64> },
            "fresh_input_tokens": if *nin > 0 { Some(*tfresh) } else { None::<u64> },
            "output_tokens": if *nout > 0 { Some(*tout) } else { None::<u64> },
            "input_samples": nin, "output_samples": nout,
        }))
        .collect();
    let collector_status = (if c.usage_dir.as_os_str().is_empty() { None } else {
        fs::read_to_string(c.usage_dir.join("freebuff-collector-status.json")).ok()
    })
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({"ok": null, "hosts": [],
            "note": "collector status unavailable; JSONL data is still reported"}));
    let daily_rows: Vec<Value> = daily
        .into_iter()
        .map(|(day, (tin, tout, nin, nout, usd, nusd))| json!({
            "day": day,
            "input_tokens": if nin > 0 { Some(tin) } else { None },
            "output_tokens": if nout > 0 { Some(tout) } else { None },
            "reported_spend_usd": if nusd > 0 { Some(usd) } else { None },
            "input_samples": nin, "output_samples": nout, "spend_samples": nusd,
        }))
        .collect();
    json!({
        "schema": "unified-usage/2",
        "days": since,
        "daily": daily_rows,
        "sources": source_reports,
        "events": all_events,
        "input_tokens_recorded": if in_count > 0 { Some(total_in) } else { None },
        "output_tokens_recorded": if out_count > 0 { Some(total_out) } else { None },
        "cached_input_tokens_recorded": if cached_count > 0 { Some(total_cached) } else { None },
        "fresh_input_tokens_recorded": if fresh_count > 0 { Some(total_fresh) } else { None },
        "reasoning_tokens_recorded": if reasoning_count > 0 { Some(total_reasoning) } else { None },
        "total_tokens_recorded": if tokens_count > 0 { Some(total_tokens) } else { None },
        "input_token_events": in_count,
        "output_token_events": out_count,
        "cached_token_events": cached_count,
        "fresh_token_events": fresh_count,
        "reasoning_token_events": reasoning_count,
        "incomplete_token_events": incomplete_events,
        "exact_input_tokens_recorded": if exact_in_count > 0 { Some(exact_in) } else { None },
        "exact_output_tokens_recorded": if exact_out_count > 0 { Some(exact_out) } else { None },
        "reported_spend_usd": if actual_count > 0 { Some(actual) } else { None },
        "reported_spend_events": actual_count,
        "estimated_api_equivalent_usd": if estimated_count > 0 { Some(estimated) } else { None },
        "estimated_events": estimated_count,
        "freebuff": {
            "hosts": fb_host_rows,
            "events": fb_events,
            "events_total": fb_events_total,
            "events_truncated": truncated,
            "incomplete_events": fb_incomplete,
            "filter": {"host": host_filter, "model": model_filter},
            "filtered": {
                "host": host_filter,
                "model": model_filter,
                "events": fb_filter.events,
                "input_tokens": opt_sum(fb_filter.input, fb_filter.input_events),
                "input_token_events": fb_filter.input_events,
                "cached_input_tokens": opt_sum(fb_filter.cached, fb_filter.cached_events),
                "cached_token_events": fb_filter.cached_events,
                "fresh_input_tokens": opt_sum(fb_filter.fresh, fb_filter.fresh_events),
                "fresh_token_events": fb_filter.fresh_events,
                "output_tokens": opt_sum(fb_filter.output, fb_filter.output_events),
                "output_token_events": fb_filter.output_events,
                "reasoning_tokens": opt_sum(fb_filter.reasoning, fb_filter.reasoning_events),
                "reasoning_token_events": fb_filter.reasoning_events,
                "total_tokens": opt_sum(fb_filter.total, fb_filter.total_events),
                "total_token_events": fb_filter.total_events,
                "incomplete_events": fb_filter.incomplete,
                "exact_input_tokens": opt_sum(fb_filter.exact_input, fb_filter.exact_input_events),
                "exact_input_token_events": fb_filter.exact_input_events,
                "exact_output_tokens": opt_sum(fb_filter.exact_output, fb_filter.exact_output_events),
                "exact_output_token_events": fb_filter.exact_output_events,
                "daily": fb_filtered_daily,
                "scope_note": "Computed over every event matching host/model in this window, not over the truncated event sample."
            },
            "collector": collector_status,
            "note": "Freebuff is included usage, not API expenditure. Model is the thread model at collection time; Freebuff stores no per-run model history. Cached input is already inside input; fresh input = input - cached (clamped). Reasoning is a subset of output and is never added again."
        },
        "recent": recent,
        "collected_at": Utc::now().to_rfc3339(),
        "note": "Null spend means unknown, not zero. Quota and subscription allowance are separate from token and cash totals."
    })
}

fn handle(mut request: Request, c: &Config) {
    let parsed=match url::Url::parse(&format!("http://localhost{}",request.url())) {Ok(v)=>v,Err(_)=>{reply(request,400,json!({"error":"bad_url"}));return;}};
    let path=parsed.path().to_owned();let query:HashMap<String,String>=parsed.query_pairs().map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    let method=request.method().clone();
    // Local peer processes are not automatically trusted, even though the port binds loopback.
    // The HTTP entrypoint must authenticate before any operation, including health and reads.
    let gateway_key=match read_secret(&c.gateway_key) {
        Ok(value)=>value,Err(_)=>{reply(request,503,json!({"error":"gateway_secret_unavailable"}));return;}
    };
    if !bearer_authenticated(&request,&gateway_key) {reply(request,401,json!({"error":"unauthorized"}));return;}
    let response=match (&method,path.as_str()) {
        (&Method::Get,"/v1/health") => (200,json!({"ok":true,"schema":"unified-control/1","service":"unified-repoql-control","rust":true,"tencent_configured":!c.tencent_base.is_empty() && !c.tencent_service.is_empty(),"openrouter_configured":!c.openrouter_key.as_os_str().is_empty(),"writes_enabled":c.writes,"now":Utc::now().to_rfc3339()})),
        (&Method::Get,"/v1/graph") => (200,graph(c,&query)),
        (&Method::Get,"/v1/usage") => (200,usage(c,&query)),
        (&Method::Get,"/v1/openrouter") => (200,openrouter(c)),
        (&Method::Get,"/v1/tencent/catalog") => (200,catalog()),
        (&Method::Post,"/v1/tencent/invoke") => {
            let mut bytes=Vec::new();
            let value=if request.as_reader().take((MAX_BODY+1) as u64).read_to_end(&mut bytes).is_ok() && bytes.len()<=MAX_BODY {
                serde_json::from_slice::<Value>(&bytes).ok()
            } else {None};
            match value {None=>(400,json!({"error":"invalid_or_oversize_json"})),Some(v)=>match invoke(c,&v) {Ok(result)=>(200,json!({"data":result})),Err((code,e))=>(code,json!({"error":e}))}}
        },
        _ => (404,json!({"error":"not_found"}))
    };
    reply(request,response.0,response.1);
}
fn main() -> Result<(),Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let is_check = args.iter().any(|a| a=="--check");
    let task_config = match args.as_slice() {
        [] => None,
        [flag] if flag=="--check" => None,
        [flag, path] if flag=="--config" => Some(PathBuf::from(path)),
        [flag, path, check] if flag=="--config" && check=="--check" => Some(PathBuf::from(path)),
        _ => return Err("invalid gateway command line".into()),
    };
    if let Some(path)=task_config.as_deref() {
        if let Err(e)=apply_windows_task_config(path) { runtime_log(Some(path),&e); return Err(e.into()); }
    }
    let c=match config() {Ok(c)=>c,Err(e)=>{runtime_log(task_config.as_deref(),&e);return Err(e.into());}};
    if is_check {
        println!("{{\"config_valid\":true,\"runtime_tested\":false}}");
        return Ok(());
    }
    let server=Server::http(format!("127.0.0.1:{}",c.port)).map_err(|_| {
        runtime_log(task_config.as_deref(),"gateway could not bind local listener");
        "gateway cannot bind the configured local port"
    })?;
    runtime_log(task_config.as_deref(),"Windows-local unified gateway started");
    for request in server.incoming_requests(){ handle(request,&c); }
    runtime_log(task_config.as_deref(),"Windows-local unified gateway stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn no_cross_edge_from_matching_names(){let mut nodes=HashMap::new();add_node(&mut nodes,"repoql","local://a","same","file",Some("local://a"));add_node(&mut nodes,"tencent","w/id","same","memory",None);assert_ne!(nodes["repoql:local://a"]["canonical_uri"],nodes["tencent:w/id"]["canonical_uri"]);}
    #[test] fn wiki_list_ids_are_extracted_defensively(){let k=["wiki_id","id"];let l=["wikis","items"];assert_eq!(ids_from_list(&json!({"wikis":[{"wiki_id":"a"},{"id":"b"},{"id":"a"},{"x":1}]}),&k,&l),vec!["a","b"]);assert!(ids_from_list(&json!(null),&k,&l).is_empty());assert_eq!(ids_from_list(&json!([{"team_id":"t"}]),&["team_id"],&l),vec!["t"]);}
    #[test] fn write_actions_are_not_reads(){assert!(!readonly_action("meta/agent/delete"));assert!(!readonly_action("chat-memory/clear"));assert!(readonly_action("knowledge/wiki/graph"));}
    #[test] fn repoql_graph_is_namespaced(){let mut n=HashMap::new();let mut e=Vec::new();normalize_repoql(&json!({"rows":[{"source_uri":"x","target_uri":"y","type":"REFERS_TO"}]}),&mut n,&mut e);assert_eq!(e.len(),1);assert_eq!(n.len(),2);assert_eq!(e[0]["source"],"repoql:x");}
    #[test] fn memory_fallback_pairs_a_tencent_node_with_its_repoql_document(){
        let data=json!({"rows":[{"uri":"memorycore://data/scenes/a.md","headline":"Scene A"}]});
        let mut n=HashMap::new();
        assert_eq!(mirror_memories_as_tencent(&data,&mut n),1);
        let tx=n.values().find(|v|v["source_system"]=="tencent").unwrap();
        let rq=n.values().find(|v|v["source_system"]=="repoql").unwrap();
        assert_eq!(tx["canonical_uri"],rq["canonical_uri"]);
        assert_eq!(tx["provenance"],"memorycore_fallback");
    }
    #[test] fn hub_doc_slug_follows_the_wiki_sync_rule(){
        assert_eq!(hub_doc_slug("agent-guides/Fleet Lifecycle.md"),Some("agent-guides-fleet-lifecycle".into()));
        assert_eq!(hub_doc_slug("README.md"),Some("readme".into()));
        assert_eq!(hub_doc_slug("services/1_storage_configuration.md"),Some("services-1_storage_configuration".into()));
        assert_eq!(hub_doc_slug("notes/AGENTS.md.bak"),None);
        assert_eq!(hub_doc_slug("NOTES.MD"),None);
    }
    #[test] fn hub_document_join_requires_the_import_prefix_and_a_sources_page(){
        let mut n=HashMap::new();let mut e=Vec::new();
        add_node(&mut n,"repoql","local://x/README.md","README","document",Some("local://x/README.md"));
        add_node(&mut n,"repoql","github://ali3nz/dockerhost-documentation/README.md","README","document",Some("github://ali3nz/dockerhost-documentation/README.md"));
        add_node(&mut n,"tencent","w/sources/readme","README","memory",None);
        hub_document_join(&n,&mut e,"github://ali3nz/dockerhost-documentation/");
        assert_eq!(e.len(),1);
        assert_eq!(e[0]["type"],"SAME_SOURCE_DOCUMENT");
        assert_eq!(e[0]["source"],"repoql:github://ali3nz/dockerhost-documentation/README.md");
        assert_eq!(e[0]["target"],"tencent:w/sources/readme");
        let mut disabled=Vec::new();
        hub_document_join(&n,&mut disabled,"");
        assert!(disabled.is_empty(),"unknown Windows import root cannot join to Dockerhost hub");
        let mut different=Vec::new();
        hub_document_join(&n,&mut different,"github://another/repository/");
        assert!(different.is_empty(),"an unrelated imported source must never match");
    }
    #[test] fn bounded_sample_keeps_a_cross_pair_ahead_of_degree(){
        let mut all=Vec::new();let mut edges=Vec::new();
        for i in 0..30 {
            for s in ["repoql","tencent"] {
                all.push(json!({"id":format!("{s}:n{i}"),"source_system":s,"source_id":format!("n{i}")}));
                edges.push(json!({"source":format!("{s}:n{i}"),"target":format!("{s}:n{}",(i+1)%30),"source_system":s}));
            }
        }
        all.push(json!({"id":"repoql:doc","source_system":"repoql","source_id":"github://ali3nz/dockerhost-documentation/readme.md","canonical_uri":"github://ali3nz/dockerhost-documentation/readme.md"}));
        all.push(json!({"id":"tencent:w/sources/readme","source_system":"tencent","source_id":"w/sources/readme"}));
        edges.push(json!({"source":"repoql:doc","target":"tencent:w/sources/readme","source_system":"cross"}));
        let out=bounded_sample(all,&edges,20,"github://ali3nz/dockerhost-documentation/");
        let ids:HashSet<&str>=out.iter().filter_map(|n|n["id"].as_str()).collect();
        assert_eq!(out.len(),20);
        assert!(ids.contains("repoql:doc")&&ids.contains("tencent:w/sources/readme"));
    }
    #[test] fn bounded_sample_caps_the_cross_reserve_at_half_a_quota(){
        let mut all=Vec::new();let mut edges=Vec::new();
        for i in 0..40 {
            for s in ["repoql","tencent"] {
                all.push(json!({"id":format!("{s}:n{i}"),"source_system":s,"source_id":format!("n{i}")}));
                edges.push(json!({"source":format!("{s}:n{i}"),"target":format!("{s}:n{}",(i+1)%40),"source_system":s}));
            }
        }
        for i in 0..12 {
            all.push(json!({"id":format!("repoql:y{i}"),"source_system":"repoql","source_id":format!("github://ali3nz/dockerhost-documentation/{i}.md"),"canonical_uri":format!("github://ali3nz/dockerhost-documentation/{i}.md")}));
            all.push(json!({"id":format!("tencent:w/sources/{i}"),"source_system":"tencent","source_id":format!("w/sources/{i}")}));
            edges.push(json!({"source":format!("repoql:y{i}"),"target":format!("tencent:w/sources/{i}"),"source_system":"cross"}));
        }
        let out=bounded_sample(all,&edges,20,"github://ali3nz/dockerhost-documentation/");
        let ids:HashSet<&str>=out.iter().filter_map(|n|n["id"].as_str()).collect();
        assert_eq!(out.len(),20);
        let pairs=(0..12).filter(|i|ids.contains(format!("repoql:y{i}").as_str())&&ids.contains(format!("tencent:w/sources/{i}").as_str())).count();
        assert_eq!(pairs,5);
    }
    #[test] fn bounded_sample_pairs_align_even_when_cross_degrees_differ(){
        // One repoql document names two wiki pages, another one; the reserve must walk keys, not degrees.
        let mut all=Vec::new();let mut edges=Vec::new();
        all.push(json!({"id":"repoql:a","source_system":"repoql","source_id":"github://ali3nz/dockerhost-documentation/a1.md","canonical_uri":"github://ali3nz/dockerhost-documentation/a1.md"}));
        all.push(json!({"id":"repoql:b","source_system":"repoql","source_id":"github://ali3nz/dockerhost-documentation/b1.md","canonical_uri":"github://ali3nz/dockerhost-documentation/b1.md"}));
        all.push(json!({"id":"tencent:w/sources/a1","source_system":"tencent","source_id":"w/sources/a1"}));
        all.push(json!({"id":"tencent:w/sources/a2","source_system":"tencent","source_id":"w/sources/a2"}));
        all.push(json!({"id":"tencent:w/sources/b1","source_system":"tencent","source_id":"w/sources/b1"}));
        edges.push(json!({"source":"repoql:a","target":"tencent:w/sources/a1","source_system":"cross"}));
        edges.push(json!({"source":"repoql:a","target":"tencent:w/sources/a2","source_system":"cross"}));
        edges.push(json!({"source":"repoql:b","target":"tencent:w/sources/b1","source_system":"cross"}));
        let out=bounded_sample(all,&edges,4,"github://ali3nz/dockerhost-documentation/");
        let ids:HashSet<&str>=out.iter().filter_map(|n|n["id"].as_str()).collect();
        assert_eq!(out.len(),4);
        // The reserve cap cuts both sides at the same key (a1), then the degree pass pairs a with a2 too.
        let pairs=[("repoql:a","tencent:w/sources/a1"),("repoql:a","tencent:w/sources/a2"),("repoql:b","tencent:w/sources/b1")];
        let complete=pairs.iter().filter(|(s,t)|ids.contains(s)&&ids.contains(t)).count();
        assert_eq!(complete,2);
    }
    #[test] fn bounded_sample_one_sided_and_tiny_limits(){
        let all:Vec<Value>=(0..30).map(|i|json!({"id":format!("repoql:n{i}"),"source_system":"repoql","source_id":format!("n{i}")})).collect();
        let edges:Vec<Value>=(0..30).map(|i|json!({"source":format!("repoql:n{i}"),"target":format!("repoql:n{}",(i+1)%30),"source_system":"repoql"})).collect();
        assert_eq!(bounded_sample(all.clone(),&edges,10,"github://ali3nz/dockerhost-documentation/").len(),10);
        assert_eq!(bounded_sample(all,&[],10,"github://ali3nz/dockerhost-documentation/").len(),10);
    }
    #[test] fn tencent_permissions_error_is_not_silently_accepted(){assert!(!readonly_action("knowledge/wiki/delete"));}
    #[test] fn usage_reader_capacity_covers_measured_openchamber_feed() {
        assert!(MAX_USAGE_FILE_BYTES >= 52_536 * 800);
        assert!(MAX_USAGE_ROWS > 52_536);
    }
    #[test] fn disabled_webserver_opencode_go_not_counted(){assert!(SOURCES.iter().all(|(id,_)|*id!="opencode-go-webserver"));}
    #[test] fn fresh_input_never_double_counts_cache(){
        assert_eq!(fresh_input(Some(100),Some(40)),Some(60));
        assert_eq!(fresh_input(Some(10),Some(20)),Some(0));
        assert_eq!(fresh_input(None,Some(1)),None);
        assert_eq!(fresh_input(Some(10),None),None);
    }
    fn status_for(lines: Option<&str>, tag: &str) -> Value {
        let dir = std::env::temp_dir().join(format!("unified-status-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        if let Some(body) = lines { fs::write(dir.join("codex-pro.jsonl"), body).unwrap(); }
        let c = Config{port:0,repoql_base:"http://127.0.0.1:18100".into(),repoql_token:dir.join("rt"),tencent_base:String::new(),tencent_service:String::new(),tencent_key:dir.join("tk"),wiki_ids:Vec::new(),hub_doc_prefix:String::new(),usage_dir:dir.clone(),writes:false,gateway_key:dir.join("gw"),openrouter_key:dir.join("ok"),openrouter_management_key:dir.join("om")};
        let report = usage(&c, &HashMap::new());
        let row = report["sources"].as_array().unwrap().iter()
            .find(|r| r["id"] == "codex-pro").cloned().unwrap();
        let _ = fs::remove_dir_all(&dir);
        row
    }
    #[test] fn subscription_quota_served_not_no_token_data() {
        let now = Utc::now().to_rfc3339();
        let row = format!("{{\"timestamp\":\"{now}\",\"event_id\":\"codex-pro:five_hour:{now}\",\"source_id\":\"codex-pro\",\"host\":\"dockerhost\",\"metric_type\":\"subscription_quota\",\"window_type\":\"five_hour\",\"utilization_percent\":12,\"window_duration_minutes\":300,\"input_tokens\":null,\"output_tokens\":null,\"billing_class\":\"subscription\"}}\n");
        let served = status_for(Some(&row), "quota");
        assert_eq!(served["status"], "available");
        let windows = served["quota_windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["utilization_percent"], 12);
        assert_eq!(served["events"], 1);
    }
    #[test] fn source_status_four_cases() {
        // 1. No file at all: unavailable, never a healthy zero.
        let none = status_for(None, "none");
        assert_eq!(none["status"], "unavailable");
        assert!(none["latest_at"].is_null());
        // 2. Run records only (no token fields): no_token_data, null tokens, run time kept separate.
        let run_only = "{\"timestamp\":\"2026-09-22T05:52:28Z\",\"event_id\":\"t-run\",\"source_id\":\"codex-pro\",\"engine\":\"codex\",\"status\":\"failed\",\"input_tokens\":null,\"output_tokens\":null}\n";
        let no_tokens = status_for(Some(run_only), "run");
        assert_eq!(no_tokens["status"], "no_token_data");
        assert_eq!(no_tokens["events"], 0);
        assert!(no_tokens["latest_at"].is_null());
        assert_eq!(no_tokens["last_run_at"], "2026-09-22T05:52:28Z");
        // 3. Valid token row older than 30 days: stale.
        let old_ts = (Utc::now() - chrono::Duration::days(45)).to_rfc3339();
        let stale_line = format!("{{\"timestamp\":\"{old_ts}\",\"event_id\":\"t-stale\",\"source_id\":\"codex-pro\",\"engine\":\"codex\",\"status\":\"ok\",\"input_tokens\":100,\"output_tokens\":10}}\n");
        let stale = status_for(Some(&stale_line), "stale");
        assert_eq!(stale["status"], "stale");
        // Outside the default 30-day read window, so no windowed events; the stale
        // verdict still comes from the whole-file newest token record.
        assert_eq!(stale["events"], 0);
        // 4. Fresh valid token row: available.
        let fresh_ts = Utc::now().to_rfc3339();
        let fresh_line = format!("{{\"timestamp\":\"{fresh_ts}\",\"event_id\":\"t-fresh\",\"source_id\":\"codex-pro\",\"engine\":\"codex\",\"status\":\"ok\",\"input_tokens\":100,\"output_tokens\":10}}\n");
        let fresh = status_for(Some(&fresh_line), "fresh");
        assert_eq!(fresh["status"], "available");
        assert_eq!(fresh["events"], 1);
    }
    #[test] fn openrouter_counted_only_once(){assert_eq!(SOURCES.iter().filter(|(id,_)|*id=="openrouter").count(),1);}
    #[test] fn freebuff_filter_key_is_the_observed_host(){
        assert_eq!(fb_host_key("freebuff-dockerhost"),"dockerhost");
        assert_eq!(fb_host_key("freebuff-webserver"),"webserver");
        assert_eq!(fb_host_key("opencode-go-dockerhost"),"opencode-go-dockerhost");
    }
    #[test] fn filter_ignores_empty_and_all(){
        assert_eq!(filter_value(None),None);
        let empty="".to_owned(); let all="all".to_owned(); let host="webserver".to_owned();
        assert_eq!(filter_value(Some(&empty)),None);
        assert_eq!(filter_value(Some(&all)),None);
        assert_eq!(filter_value(Some(&host)),Some("webserver"));
        let event=json!({"host":"webserver","model":"m1"});
        assert!(matches_filter(&event,None,None));
        assert!(matches_filter(&event,Some("webserver"),Some("m1")));
        assert!(!matches_filter(&event,Some("dockerhost"),None));
        assert!(!matches_filter(&event,None,Some("m2")));
    }
    #[test] fn filtered_totals_cover_more_than_the_event_sample(){
        let dir=std::env::temp_dir().join(format!("unified-filter-test-{}",std::process::id()));
        let _=fs::remove_dir_all(&dir); fs::create_dir_all(&dir).unwrap();
        let now=Utc::now();
        let models=["m1","m2","m3"];
        let mut expected_in=0u64; let mut expected_fresh=0u64; let mut expected_total=0u64;
        let mut expected_model3=0u64; let mut expected_model3_in=0u64;
        let mut expected_web_m2=0u64;
        let mut web_m2_in=0u64; let mut web_m2_cached=0u64; let mut web_m2_fresh=0u64;
        let mut web_m2_out=0u64; let mut web_m2_total=0u64;
        let mut web_m2_daily: BTreeMap<String,(u64,u64,u64)> = BTreeMap::new();
        for (file,host,count) in [("freebuff-dockerhost.jsonl","dockerhost",3900usize),("freebuff-webserver.jsonl","webserver",1300usize)] {
            let mut lines=String::new();
            for i in 0..count {
                let model=models[i%3];
                let input=1000u64+(i as u64);
                let cached=400u64;
                let output=50u64;
                expected_in+=input; expected_fresh+=input-cached; expected_total+=input+output;
                if model=="m3" { expected_model3+=1; expected_model3_in+=input; }
                let ts=now-chrono::Duration::seconds((i as i64)*60);
                if host=="webserver" && model=="m2" {
                    expected_web_m2+=1;
                    web_m2_in+=input; web_m2_cached+=cached; web_m2_fresh+=input-cached;
                    web_m2_out+=output; web_m2_total+=input+output;
                    let day=ts.format("%Y-%m-%d").to_string();
                    let b=web_m2_daily.entry(day).or_insert((0,0,0));
                    b.0+=input; b.1+=input-cached; b.2+=output;
                }
                lines.push_str(&json!({"timestamp":ts.to_rfc3339(),"event_id":format!("{host}-{i}"),"source_id":format!("freebuff-{host}"),"host":host,"model":model,"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,"total_tokens":input+output,"usage_incomplete":false}).to_string());
                lines.push('\n');
            }
            fs::write(dir.join(file),lines).unwrap();
        }
        let c=Config{port:0,repoql_base:"http://127.0.0.1:18100".into(),repoql_token:dir.join("rt"),tencent_base:String::new(),tencent_service:String::new(),tencent_key:dir.join("tk"),wiki_ids:Vec::new(),hub_doc_prefix:String::new(),usage_dir:dir.clone(),writes:false,gateway_key:dir.join("gw"),openrouter_key:dir.join("ok"),openrouter_management_key:dir.join("om")};
        let mut q=HashMap::new(); q.insert("days".to_owned(),"30".to_owned());
        let all=usage(&c,&q);
        let f=&all["freebuff"]["filtered"];
        assert_eq!(f["events"],json!(5200));
        assert_eq!(f["input_tokens"],json!(expected_in));
        assert_eq!(f["fresh_input_tokens"],json!(expected_fresh));
        assert_eq!(f["total_tokens"],json!(expected_total));
        assert_eq!(all["freebuff"]["events_total"],json!(5200));
        assert_eq!(all["freebuff"]["events"].as_array().unwrap().len(),5000);
        assert_eq!(all["freebuff"]["events_truncated"],json!(true));
        q.insert("model".to_owned(),"m3".to_owned());
        let filtered=usage(&c,&q);
        let f=&filtered["freebuff"]["filtered"];
        assert_eq!(f["events"],json!(expected_model3));
        assert_eq!(f["input_tokens"],json!(expected_model3_in));
        assert_eq!(filtered["freebuff"]["events_truncated"],json!(false));
        let daily: u64=f["daily"].as_array().unwrap().iter().filter_map(|d|d["input_tokens"].as_u64()).sum();
        assert_eq!(daily,expected_model3_in);
        q.insert("host".to_owned(),"webserver".to_owned());
        q.insert("model".to_owned(),"m2".to_owned());
        let both=usage(&c,&q);
        let f=&both["freebuff"]["filtered"];
        assert_eq!(f["events"],json!(expected_web_m2));
        assert_eq!(f["input_tokens"],json!(web_m2_in));
        assert_eq!(f["cached_input_tokens"],json!(web_m2_cached));
        assert_eq!(f["fresh_input_tokens"],json!(web_m2_fresh));
        assert_eq!(f["output_tokens"],json!(web_m2_out));
        assert_eq!(f["total_tokens"],json!(web_m2_total));
        let daily_rows=f["daily"].as_array().unwrap();
        assert_eq!(daily_rows.len(),web_m2_daily.len());
        for row in daily_rows {
            let day=row["day"].as_str().unwrap();
            let expect=web_m2_daily.get(day).unwrap();
            assert_eq!(row["input_tokens"].as_u64().unwrap(),expect.0);
            assert_eq!(row["fresh_input_tokens"].as_u64().unwrap(),expect.1);
            assert_eq!(row["output_tokens"].as_u64().unwrap(),expect.2);
        }
        assert!(both["freebuff"]["events"].as_array().unwrap().iter().all(|e|e["host"]==json!("webserver")));
        let _=fs::remove_dir_all(&dir);
    }

    #[test] fn inject_identity_meta_discovery_gets_server_key() {
        // meta/* with header-only identity: the server-side user_key is injected.
        let payload = json!({"limit": 20});
        let out = inject_identity("meta/team/list", &payload, "TESTKEY");
        assert_eq!(out["user_key"], json!("TESTKEY"));
        assert_eq!(out["limit"], json!(20), "original payload fields survive");
    }

    #[test] fn inject_identity_team_list_pins_server_identity() {
        // Sol turn 2: meta/team/list is the panel's discovery call and must always
        // resolve to the configured server identity.
        let payload = json!({"user_id": "usr-someone-else"});
        let out = inject_identity("meta/team/list", &payload, "SERVERKEY");
        assert_eq!(out["user_key"], json!("SERVERKEY"));
        assert!(out.get("user_id").is_none(), "caller-selected identity is stripped from team discovery");
        let payload = json!({"user_key": "forged", "user_id": "usr-someone-else"});
        let out = inject_identity("meta/team/list", &payload, "SERVERKEY");
        assert_eq!(out["user_key"], json!("SERVERKEY"));
        assert!(out.get("user_id").is_none(), "forged key + alternate id also pinned");
    }

    #[test] fn inject_identity_never_second_guesses_operator_authored_identity() {
        // Other meta/* actions keep the pass-through contract for explicit identity.
        let payload = json!({"user_id": "usr-operator"});
        let out = inject_identity("meta/team/show", &payload, "SERVERKEY");
        assert!(out.get("user_key").is_none(), "payload user_id stays authoritative outside team/list");
        let payload = json!({"user_key": "  "}); // whitespace only does NOT count as identity
        let out = inject_identity("meta/team/show", &payload, "SERVERKEY");
        assert_eq!(out["user_key"], json!("SERVERKEY"));
    }

    #[test] fn inject_identity_non_meta_actions_stay_header_only() {
        // Live-proved: chat-memory/* resolves the caller from the headers.
        for action in ["chat-memory/team-assets", "chat-memory/mine", "chat-memory/my-agents"] {
            let out = inject_identity(action, &json!({"team_id":"team-x"}), "TESTKEY");
            assert!(out.get("user_key").is_none(), "{action} must not receive a payload key");
        }
    }

    #[test] fn inject_identity_non_object_payload_is_untouched() {
        let out = inject_identity("meta/team/list", &json!([1,2,3]), "TESTKEY");
        assert_eq!(out, json!([1,2,3]), "array payload neither mutated nor panicking");
        let out = inject_identity("meta/team/list", &json!(null), "TESTKEY");
        assert_eq!(out, json!(null));
    }

    #[test] fn reject_credentials_in_loopback_url() {
        assert!(!valid_base("http://127.0.0.1:18000@evil.example",true));
        assert!(!valid_base("http://localhost:18000/path",true));
        assert!(valid_base("http://127.0.0.1:18100",true));
        assert!(!valid_base("http://evil.example:18100",true));
    }

    #[test] fn memory_category_names_the_three_kinds(){
        assert_eq!(memory_category("memorycore://data/records/2026-10-14/m_1.md"),"memory-record");
        assert_eq!(memory_category("memorycore://data/scenes/team/agent/Setup.md"),"memory-scene");
        assert_eq!(memory_category("memorycore://data/personas/team/agent/persona.md"),"memory-persona");
        assert_eq!(memory_category("memorycore://data/overview.md"),"memory");
    }

    #[test] fn normalize_memory_rows_labels_by_headline_and_joins_nothing(){
        let data=json!({"rows":[
            {"uri":"memorycore://data/records/2026-10-14/m_1.md","name":"m_1.md","headline":"A remembered episode"},
            {"uri":"memorycore://data/overview.md","name":"overview.md","headline":"   "},
        ]});
        let mut nodes=HashMap::new();
        normalize_memory_rows(&data,&mut nodes);
        let a=nodes.get("memories:memorycore://data/records/2026-10-14/m_1.md").unwrap();
        assert_eq!(a["label"],json!("A remembered episode"));
        assert_eq!(a["category"],json!("memory-record"));
        assert_eq!(a["source_system"],json!("memories"));
        assert!(a["canonical_uri"].is_null(),"a memory joins nothing by canonical uri");
        let b=nodes.get("memories:memorycore://data/overview.md").unwrap();
        assert_eq!(b["label"],json!("overview.md"),"a blank headline falls back to the file name");
    }

    #[test] fn bounded_sample_reserves_a_quarter_for_memories(){
        let mut all=Vec::new();
        for i in 0..400 {all.push(json!({"id":format!("repoql:r{i}"),"source_system":"repoql"}));}
        for i in 0..400 {all.push(json!({"id":format!("memories:m{i}"),"source_system":"memories"}));}
        let out=bounded_sample(all,&[],100,"github://ali3nz/dockerhost-documentation/");
        let mem=out.iter().filter(|n|n["source_system"]=="memories").count();
        assert_eq!(out.len(),100);
        assert_eq!(mem,25,"a quarter of the bounded graph is the memories reserve");
    }

    #[test] fn bounded_sample_shows_every_memory_when_few_and_fills_when_alone(){
        let mut all=Vec::new();
        for i in 0..400 {all.push(json!({"id":format!("repoql:r{i}"),"source_system":"repoql"}));}
        for i in 0..3 {all.push(json!({"id":format!("memories:m{i}"),"source_system":"memories"}));}
        let out=bounded_sample(all,&[],20,"github://ali3nz/dockerhost-documentation/");
        let mem=out.iter().filter(|n|n["source_system"]=="memories").count();
        assert_eq!(mem,3,"a handful of memories is never cut");
        let mut only_mem=Vec::new();
        for i in 0..50 {only_mem.push(json!({"id":format!("memories:m{i}"),"source_system":"memories"}));}
        let out=bounded_sample(only_mem,&[],10,"github://ali3nz/dockerhost-documentation/");
        assert_eq!(out.len(),10,"memories alone fill the viewport");
    }

    #[test] fn bounded_sample_small_limits_keep_wired_capacity(){
        // Below four the memories reserve truncates to zero, and every slot must still go to the
        // wired systems while any of their nodes is eligible; memories take exactly a quarter above.
        for limit in 1..=5usize {
            let mut all=Vec::new();
            for i in 0..30 {all.push(json!({"id":format!("repoql:r{i:03}"),"source_system":"repoql"}));}
            for i in 0..30 {all.push(json!({"id":format!("tencent:t{i:03}"),"source_system":"tencent"}));}
            for i in 0..400 {all.push(json!({"id":format!("memories:m{i}"),"source_system":"memories"}));}
            let out=bounded_sample(all,&[],limit,"github://ali3nz/dockerhost-documentation/");
            let count=|s:&str|out.iter().filter(|n|n["source_system"]==s).count();
            assert_eq!(out.len(),limit,"the viewport is filled at limit {limit}");
            assert_eq!(count("memories"),limit/4,"memories hold exactly their reserve at limit {limit}");
            assert_eq!(count("repoql")+count("tencent"),limit-limit/4,"the wired systems keep every other slot at limit {limit}");
        }
    }

    #[test] fn bounded_sample_small_limits_keep_a_cross_pair_whole(){
        // One cross pair beside the memories at a tiny limit: the pair survives whole and the
        // graph's endpoint retain (both endpoints in the node set) keeps the cross edge.
        let mut all=vec![
            json!({"id":"repoql:hub/file.md","source_system":"repoql","canonical_uri":"hub://file"}),
            json!({"id":"tencent:w1/hub/file","source_system":"tencent","canonical_uri":null}),
        ];
        for i in 0..400 {all.push(json!({"id":format!("memories:m{i}"),"source_system":"memories"}));}
        let edges=vec![json!({"id":"match:1","source":"repoql:hub/file.md","target":"tencent:w1/hub/file","source_system":"cross"})];
        for limit in 4..=6usize {
            let out=bounded_sample(all.clone(),&edges,limit,"github://ali3nz/dockerhost-documentation/");
            let ids:HashSet<String>=out.iter().filter_map(|n|n["id"].as_str().map(str::to_owned)).collect();
            assert!(ids.contains("repoql:hub/file.md")&&ids.contains("tencent:w1/hub/file"),"the cross pair survives whole at limit {limit}");
            let kept=edges.iter().filter(|e|e["source"].as_str().map(|s|ids.contains(s)).unwrap_or(false)&&e["target"].as_str().map(|s|ids.contains(s)).unwrap_or(false)).count();
            assert_eq!(kept,1,"the cross edge keeps both endpoints at limit {limit}");
            // Both wired nodes are present; with no other wired node left, the remaining slots may only
            // go to memories (a full viewport, never a starved pair) — and never to a memory before a
            // wired node: with two eligible wired nodes and limit L, memories can hold at most L-2.
            assert_eq!(out.iter().filter(|n|n["source_system"]!="memories").count(),2,"no wired node yields at limit {limit}");
            assert!(out.iter().filter(|n|n["source_system"]=="memories").count()<=limit-2,"memories never crowd out a wired node at limit {limit}");
        }
    }
}
