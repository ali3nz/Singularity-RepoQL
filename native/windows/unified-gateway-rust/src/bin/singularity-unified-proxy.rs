//! Fixed, local transport for the six authenticated unified dashboard routes.
//! It accepts a prepared request on stdin, not browser headers or a target URL.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Read},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const FRAME: u64 = 6 * 1024 * 1024;
const RESPONSE: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    host: IpAddr,
    port: u16,
    route: Route,
    token_file: PathBuf,
    query: String,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Route {
    Health,
    Graph,
    Usage,
    Openrouter,
    TencentCatalog,
    TencentInvoke,
}

impl Route {
    fn path(&self) -> &'static str {
        match self {
            Self::Health => "/v1/health",
            Self::Graph => "/v1/graph",
            Self::Usage => "/v1/usage",
            Self::Openrouter => "/v1/openrouter",
            Self::TencentCatalog => "/v1/tencent/catalog",
            Self::TencentInvoke => "/v1/tencent/invoke",
        }
    }
}

fn failure(error: &str) -> Value {
    json!({"available":false,"error":error})
}

fn safe_metadata(path: &Path) -> Option<fs::Metadata> {
    let info = fs::symlink_metadata(path).ok()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return None;
        }
    }
    (!info.file_type().is_symlink()).then_some(info)
}

fn token(path: &Path) -> Option<String> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return None;
    }
    if !path
        .parent()?
        .ancestors()
        .all(|p| safe_metadata(p).is_some_and(|m| m.is_dir()))
    {
        return None;
    }
    let meta = safe_metadata(path)?;
    if !meta.is_file() || meta.len() > 8192 {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(8193)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() > 8192 {
        return None;
    }
    let trimmed = text.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| (32..=126).contains(&b)) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn query_valid(query: &str) -> bool {
    let bytes = query.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if bytes
                .get(i + 1..i + 3)
                .is_some_and(|v| v.iter().all(u8::is_ascii_hexdigit)) =>
            {
                i += 3
            }
            b if b.is_ascii_alphanumeric()
                || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'&' | b'=') =>
            {
                i += 1
            }
            _ => return false,
        }
    }
    true
}

fn forward(req: Request) -> Value {
    if !req.host.is_loopback()
        || !matches!(req.host.to_string().as_str(), "127.0.0.1" | "::1")
        || req.port == 0
        || req.query.len() > 65_536
        || !query_valid(&req.query)
    {
        return failure("unified_native_request_refused");
    }
    let post = matches!(req.route, Route::TencentInvoke);
    if post != req.body.is_some()
        || (post && !req.query.is_empty())
        || req.body.as_ref().is_some_and(|s| {
            s.len() > 5 * 1024 * 1024
                || !matches!(serde_json::from_str::<Value>(s), Ok(Value::Object(_)))
        })
    {
        return failure("unified_native_request_refused");
    }
    let Some(secret) = token(&req.token_file) else {
        return failure("unified_gateway_not_configured");
    };
    let host = match req.host {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let url = format!(
        "http://{host}:{}{}{}{}",
        req.port,
        req.route.path(),
        if req.query.is_empty() { "" } else { "?" },
        req.query
    );
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(Duration::from_secs(if matches!(req.route, Route::Graph) {
            75
        } else {
            18
        }))
        .build();
    let request = agent
        .request(if post { "POST" } else { "GET" }, &url)
        .set("Authorization", &format!("Bearer {secret}"))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json");
    let response = match match req.body {
        Some(body) => request.send_string(&body),
        None => request.call(),
    } {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return failure("unified_service_unavailable"),
    };
    match response.status() {
        301 | 302 | 303 | 307 | 308 => return failure("unified_upstream_redirect_refused"),
        200..=299 => (),
        code => return failure(&format!("unified_http_{code}")),
    }
    let mut raw = Vec::new();
    if response
        .into_reader()
        .take(RESPONSE + 1)
        .read_to_end(&mut raw)
        .is_err()
    {
        return failure("unified_service_unavailable");
    }
    if raw.len() as u64 > RESPONSE {
        return failure("unified_response_too_large");
    }
    match serde_json::from_slice::<Value>(&raw) {
        Ok(value) => json!({"ok":true,"payload":value}),
        Err(_) => failure("unified_invalid_response"),
    }
}

fn main() -> io::Result<()> {
    let mut frame = Vec::new();
    io::stdin().take(FRAME + 1).read_to_end(&mut frame)?;
    let result = if frame.len() as u64 <= FRAME {
        serde_json::from_slice(&frame)
            .map(forward)
            .unwrap_or_else(|_| failure("unified_native_request_refused"))
    } else {
        failure("unified_native_request_refused")
    };
    println!("{result}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_query_keeps_url_delimiters_encoded() {
        assert!(query_valid("q=%E9%8D%B5%2F%3F%23+space&offset=1"));
        for invalid in [
            "q=#anchor",
            "q=%",
            "q=%2",
            "q=%zz",
            "q=a/b",
            "q=a\\b",
            "q=a?b",
            "q=x\n",
        ] {
            assert!(!query_valid(invalid));
        }
    }
}
