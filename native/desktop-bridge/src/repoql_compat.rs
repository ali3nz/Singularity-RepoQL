//! Fail-closed RepoQL connector contract for native Windows releases.
//! Version probing is read-only. The actual RepoQL executable is supplied by
//! the end user; it is never bundled, replaced or invoked to mutate state.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const VERSION: &str = "1.7.18";
pub const CONNECTOR_CONTRACT: &str = "fetch-render";
const KANZO: &str = include_str!("../../../connectors/kanzo/manifest.yaml");
const MEMORY: &str = include_str!("../../../connectors/memorycore/manifest.yaml");
const ALLOWED_TOP_LEVEL: &[&str] = &[
    "scheme",
    "title",
    "summary",
    "calls",
    "recordsVersion",
    "uri",
    "partitioned",
    "embedding",
    "network",
    "secrets",
    "functions",
    "events",
    "settings",
    "source",
    "inference",
    "fetchIntervalSeconds",
    "fullFetchIntervalSeconds",
    "retentionDays",
    "maxValueBytes",
    "memoryMiB",
    "workspaceMiB",
];

fn version_from_line(line: &str) -> Option<String> {
    let line = line.trim().to_ascii_lowercase();
    // RepoQL 1.7.18 on Windows prints just `1.7.18` for --version.
    // Bare versions are accepted only when they comprise an entire line.
    let trimmed = line.trim_start_matches('v');
    let is_version = |s: &str| {
        let parts = s.split('.').collect::<Vec<_>>();
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    };
    if is_version(trimmed) {
        return Some(trimmed.to_string());
    }
    let rest = line
        .strip_prefix("repoql")
        .or_else(|| line.strip_prefix("rql"))?;
    if !rest
        .chars()
        .next()
        .is_some_and(|c| c.is_whitespace() || c == ':')
    {
        return None;
    }
    for token in rest.split_whitespace() {
        let version = token.trim_start_matches('v');
        let numeric = version.split('.').collect::<Vec<_>>();
        if numeric.len() == 3
            && numeric
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        {
            return Some(version.to_string());
        }
    }
    None
}

pub fn parse_version(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if let Some(version) = version_from_line(trimmed) {
        if trimmed.lines().count() == 1
            && trimmed
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || c == 'v')
        {
            return Some(version);
        }
    }
    if output.lines().any(|line| {
        let line = line.trim();
        let stripped = line.strip_prefix('v').unwrap_or(line);
        let parts = stripped.split('.').collect::<Vec<_>>();
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    }) {
        return None;
    }
    let mut values = output.lines().filter_map(version_from_line);
    let first = values.next()?;
    if values.any(|v| v != first) {
        return None;
    }
    Some(first)
}

fn scalar(value: &str) -> &str {
    let value = value.split(" #").next().unwrap_or(value).trim();
    if value.len() >= 2 {
        let first = value.as_bytes()[0] as char;
        let last = value.as_bytes()[value.len() - 1] as char;
        if (first == '\'' || first == '"') && first == last {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn top_level_fields(manifest: &str) -> Option<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || line.starts_with(' ')
            || line.starts_with('\t')
        {
            continue;
        }
        let (key, value) = line.split_once(':')?;
        let key = key.trim();
        if key.eq_ignore_ascii_case("abi") || !ALLOWED_TOP_LEVEL.contains(&key) {
            return None;
        }
        if fields
            .insert(key.to_string(), value.trim().to_string())
            .is_some()
        {
            return None;
        }
    }
    Some(fields)
}

fn has_fetch_render_contract(manifest: &str, expected_scheme: &str) -> bool {
    let Some(fields) = top_level_fields(manifest) else {
        return false;
    };
    for required in [
        "scheme",
        "title",
        "summary",
        "calls",
        "recordsVersion",
        "fetchIntervalSeconds",
        "fullFetchIntervalSeconds",
    ] {
        if fields
            .get(required)
            .is_none_or(|value| scalar(value).is_empty())
        {
            return false;
        }
    }
    if scalar(fields.get("scheme").unwrap()) != expected_scheme {
        return false;
    }
    let Some(calls) = fields.get("calls") else {
        return false;
    };
    let calls = scalar(calls);
    let Some(calls) = calls
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    else {
        return false;
    };
    let calls = calls
        .split(',')
        .map(|value| scalar(value.trim()))
        .collect::<Vec<_>>();
    if calls != ["parse", "fetch", "render"] {
        return false;
    }

    let positive = |key: &str| -> Option<u64> {
        let raw = scalar(fields.get(key)?);
        if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        raw.parse().ok()
    };
    let Some(records) = positive("recordsVersion") else {
        return false;
    };
    let Some(fetch) = positive("fetchIntervalSeconds") else {
        return false;
    };
    let Some(full_fetch) = positive("fullFetchIntervalSeconds") else {
        return false;
    };
    if records == 0
        || !(60..=86_400).contains(&fetch)
        || !(60..=2_592_000).contains(&full_fetch)
        || fetch != full_fetch
    {
        return false;
    }
    if let Some(max_value) = fields.get("maxValueBytes") {
        let Ok(max_value) = scalar(max_value).parse::<u64>() else {
            return false;
        };
        if !(16_384..=131_072).contains(&max_value) {
            return false;
        }
    }
    true
}

pub fn check(actual: Option<&str>, native_exe: bool) -> Value {
    let kanzo = has_fetch_render_contract(KANZO, "kanzo");
    let memory = has_fetch_render_contract(MEMORY, "memorycore");
    let exact = actual == Some(VERSION);
    json!({"ok": exact && kanzo && memory && native_exe,
        "required_version": VERSION,
        "actual_version": actual,
        "required_connector_contract": CONNECTOR_CONTRACT,
        "kanzo_contract_compatible": kanzo,
        "memorycore_contract_compatible": memory,
        "native_binary": native_exe,
        "connector_installation_allowed": exact && kanzo && memory && native_exe})
}

fn bounded_probe(path: &str) -> Option<String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let output = child.wait_with_output().ok()?;
                // A version banner must be small; never allocate an unbounded
                // response from an untrusted third-party executable.
                if output.stdout.len() > 4096 {
                    return None;
                }
                return parse_version(&String::from_utf8(output.stdout).ok()?);
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub fn run() -> i32 {
    let mut args = std::env::args().skip(2);
    let path = match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--rql" => path,
        _ => {
            eprintln!(
                "usage: singularity-desktop-bridge repoql-preflight --rql C:\\path\\to\\rql.exe"
            );
            return 2;
        }
    };
    let is_native = if cfg!(windows) {
        Path::new(&path)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("exe"))
    } else {
        true
    };
    let actual = if is_native {
        bounded_probe(&path)
    } else {
        None
    };
    let report = check(actual.as_deref(), is_native);
    println!("{report}");
    if report["ok"] == true {
        0
    } else {
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_version_and_fetch_render_contract() {
        assert_eq!(parse_version("rql 1.7.18"), Some(VERSION.into()));
        assert_eq!(parse_version("1.7.18\n"), Some(VERSION.into()));
        assert_eq!(parse_version("v1.7.18\n"), Some(VERSION.into()));
        assert_eq!(parse_version("rql 1.7.18\n1.7.17"), None);
        assert_eq!(
            parse_version("RepoQL version v1.7.18"),
            Some(VERSION.into())
        );
        assert_eq!(parse_version("some library version 1.7.18"), None);
        assert!(check(Some("1.7.18"), true)["ok"].as_bool().unwrap());
        assert!(!check(Some("1.7.17"), true)["ok"].as_bool().unwrap());
        assert!(!check(Some("1.7.15"), true)["ok"].as_bool().unwrap());
        assert!(!check(None, true)["ok"].as_bool().unwrap());
        assert!(!check(Some("1.7.18"), false)["ok"].as_bool().unwrap());
        assert_eq!(
            check(Some("1.7.18"), true)["required_connector_contract"],
            CONNECTOR_CONTRACT
        );
        assert!(
            check(Some("1.7.18"), true)["connector_installation_allowed"]
                .as_bool()
                .unwrap()
        );
        assert!(check(Some("1.7.18"), true).get("connector_abi").is_none());
    }

    #[test]
    fn bundled_manifests_use_exact_contract() {
        assert!(has_fetch_render_contract(KANZO, "kanzo"));
        assert!(has_fetch_render_contract(MEMORY, "memorycore"));
    }

    #[test]
    fn obsolete_abi_and_invalid_calls_fail_closed() {
        let base = "scheme: kanzo\ntitle: Test\nsummary: Test contract\ncalls: [parse, fetch, render]\nrecordsVersion: 2\nfetchIntervalSeconds: 900\nfullFetchIntervalSeconds: 900\n";
        assert!(has_fetch_render_contract(base, "kanzo"));
        assert!(!has_fetch_render_contract(
            &base.replace("scheme: kanzo\n", "scheme: kanzo\nabi: 1\n"),
            "kanzo"
        ));
        assert!(!has_fetch_render_contract(
            &base.replace("[parse, fetch, render]", "[parse, fetch]"),
            "kanzo"
        ));
        assert!(!has_fetch_render_contract(
            &base.replace("[parse, fetch, render]", "[fetch, parse, render]"),
            "kanzo"
        ));
        assert!(!has_fetch_render_contract(
            &base.replace("scheme: kanzo", "scheme: memorycore"),
            "kanzo"
        ));
        assert!(!has_fetch_render_contract(
            &base.replace(
                "fullFetchIntervalSeconds: 900",
                "fullFetchIntervalSeconds: 1800"
            ),
            "kanzo"
        ));
    }
}
