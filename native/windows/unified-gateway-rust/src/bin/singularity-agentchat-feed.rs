//! Read-only durable Agent Chat inbox projection for the Claude Code dashboard.
//! No cursor writes, network transport, Discord I/O or control-plane authority.
//! The dashboard compares the output with its existing Python implementation
//! before allowing this binary to supply an API result.
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const TAIL_BYTES: u64 = 128 * 1024;
const MAX_FILES: usize = 160;
const MAX_LINES: usize = 120;

#[derive(Debug)]
struct Inbox {
    mtime: u128,
    path: PathBuf,
    kind: &'static str,
    recipient: String,
}

#[derive(Serialize)]
struct Message {
    id: i64,
    #[serde(rename = "from")]
    sender: String,
    from_session: String,
    text: String,
    created_at: String,
    origin: String,
    run_number: Option<Value>,
    recipients: Vec<String>,
    sessions: Vec<String>,
}

fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn candidates(root: &Path) -> Vec<Inbox> {
    let mut out = Vec::new();
    for (dirname, kind) in [("inbox", "role"), ("inbox-sessions", "session")] {
        let folder = root.join(dirname);
        let Ok(files) = fs::read_dir(folder) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(recipient) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if !token(recipient, 90) {
                continue;
            }
            let Ok(ty) = file.file_type() else { continue };
            if !ty.is_file() || ty.is_symlink() {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let timestamp = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |delta| delta.as_nanos());
            out.push(Inbox {
                mtime: timestamp,
                path: file.path(),
                kind,
                recipient: recipient.to_owned(),
            });
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.mtime)); // stable, like Python list.sort
    out.truncate(MAX_FILES);
    out
}

#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.is_file() && b.is_file() && a.dev() == b.dev() && a.ino() == b.ino()
}
#[cfg(windows)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    // OpenOptions below refuses to follow reparse points. This is a redundant
    // attribute and file-type check, not a claim that timestamps are file IDs.
    a.is_file()
        && b.is_file()
        && a.file_attributes() & REPARSE_POINT == 0
        && b.file_attributes() & REPARSE_POINT == 0
}
#[cfg(not(any(unix, windows)))]
fn same_file(_a: &Metadata, _b: &Metadata) -> bool {
    false
}

fn tail(path: &Path) -> Vec<Vec<u8>> {
    let Ok(before) = fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if !before.is_file() || before.file_type().is_symlink() {
        return Vec::new();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if before.file_attributes() & 0x400 != 0 {
            return Vec::new();
        }
    }
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT prevents following a swapped final link.
        let mut options = fs::OpenOptions::new();
        options.read(true).custom_flags(0x0020_0000);
        options.open(path)
    };
    #[cfg(not(windows))]
    let opened = fs::File::open(path);
    let Ok(mut f) = opened else {
        return Vec::new();
    };
    let Ok(after) = f.metadata() else {
        return Vec::new();
    };
    if !same_file(&before, &after) {
        return Vec::new();
    }
    let length = after.len().min(TAIL_BYTES);
    if f.seek(SeekFrom::Start(after.len() - length)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.take(length).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    if after.len() > length {
        let Some(first_newline) = bytes.iter().position(|b| *b == b'\n') else {
            return Vec::new();
        };
        bytes.drain(..first_newline + 1);
    }
    let mut lines: Vec<Vec<u8>> = bytes
        .split(|b| *b == b'\n')
        .map(|s| s.strip_suffix(b"\r").unwrap_or(s).to_vec())
        .collect();
    // bytes.split includes an empty terminal slice, unlike Python bytes.splitlines.
    if lines.last().is_some_and(Vec::is_empty) {
        lines.pop();
    }
    let cut = lines.len().saturating_sub(MAX_LINES);
    lines.into_iter().skip(cut).collect()
}

fn integer(value: Option<&Value>) -> Option<i64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(i64::from(*b)),
        Some(Value::Number(n)) => n.as_i64().or_else(|| {
            n.as_f64().and_then(|n| {
                if n.is_finite() && n >= i64::MIN as f64 && n < i64::MAX as f64 {
                    Some(n as i64)
                } else {
                    None
                }
            })
        }),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn string(value: Option<&Value>, max: usize) -> String {
    let src = match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(true)) => "True".to_owned(),
        Some(Value::Bool(false)) => "False".to_owned(),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n != 0.0) => n.to_string(),
        _ => String::new(),
    };
    src.chars().take(max).collect()
}

fn feed(root: &Path, after: i64, limit: i64) -> Value {
    let after = after.max(0);
    if !root.is_dir() {
        return json!({"available": false, "reason": "Agent Chat state directory unavailable", "messages": [], "last_id": after});
    }
    let limit = limit.clamp(1, 150) as usize;
    let mut messages: BTreeMap<i64, Message> = BTreeMap::new();
    for inbox in candidates(root) {
        for line in tail(&inbox.path) {
            let Ok(record) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let Some(id) = integer(record.get("id")) else {
                continue;
            };
            if id <= after {
                continue;
            }
            let message = messages.entry(id).or_insert_with(|| Message {
                id,
                sender: string(record.get("from"), 48),
                from_session: string(record.get("fromSession"), 64),
                text: string(record.get("text"), 1500),
                created_at: string(record.get("createdAt"), 40),
                origin: string(record.get("origin"), 20),
                run_number: record
                    .get("runNumber")
                    .filter(|v| v.is_i64() || v.is_u64() || v.is_boolean())
                    .cloned(),
                recipients: Vec::new(),
                sessions: Vec::new(),
            });
            let recipients = if inbox.kind == "role" {
                &mut message.recipients
            } else {
                &mut message.sessions
            };
            if !recipients.contains(&inbox.recipient) {
                recipients.push(inbox.recipient.clone());
            }
        }
    }
    let count = messages.len();
    let mut ordered: Vec<Message> = messages.into_values().collect();
    for row in &mut ordered {
        row.recipients.sort();
        row.sessions.sort();
    }
    let selected: Vec<Message> = if after > 0 {
        ordered.into_iter().take(limit).collect()
    } else {
        ordered
            .into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    let last_id = selected.last().map_or(after, |m| m.id);
    json!({"available": true, "messages": selected, "last_id": last_id,
        "has_more": count > limit, "source": "durable-inbox", "read_only": true})
}

fn python_iso(when: DateTime<Utc>) -> String {
    let format = if when.timestamp_subsec_nanos() == 0 {
        SecondsFormat::Secs
    } else {
        SecondsFormat::Micros
    };
    when.to_rfc3339_opts(format, false)
}

fn presence(root: &Path, now: DateTime<Utc>) -> Value {
    if !root.is_dir() {
        return json!({"available": false, "agents": [], "reason": "Agent Chat state directory unavailable"});
    }
    let cutoff = now - Duration::minutes(5);
    let mut observed: BTreeMap<String, DateTime<Utc>> = BTreeMap::new();
    for inbox in candidates(root) {
        for line in tail(&inbox.path) {
            let Ok(record) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let Some(role) = record.get("from").and_then(Value::as_str) else {
                continue;
            };
            if !token(role, 40) {
                continue;
            }
            let Some(created) = record.get("createdAt").and_then(Value::as_str) else {
                continue;
            };
            let Ok(when) = DateTime::parse_from_rfc3339(created) else {
                continue;
            };
            let when = when.with_timezone(&Utc);
            if when < cutoff || when > now {
                continue;
            }
            let entry = observed.entry(role.to_owned()).or_insert(when);
            if *entry < when {
                *entry = when;
            }
        }
    }
    let agents: Vec<Value> = observed
        .into_iter()
        .map(|(role, when)| json!({"role": role, "status": "idle", "last_seen": python_iso(when)}))
        .collect();
    json!({"available": true, "agents": agents, "source": "durable-inbox-recent-senders",
        "read_only": true, "working_status_verified": false})
}

fn run() -> Result<Value, &'static str> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 || !matches!(args[0].as_str(), "feed" | "presence") {
        return Err("INVALID_ARGUMENTS");
    }
    let root = Path::new(&args[1]);
    if !root.is_absolute() {
        return Err("ROOT_NOT_ABSOLUTE");
    }
    match args[0].as_str() {
        "feed" if args.len() == 4 => {
            let after = args[2].parse::<i64>().map_err(|_| "INVALID_AFTER")?;
            let limit = args[3].parse::<i64>().map_err(|_| "INVALID_LIMIT")?;
            Ok(feed(root, after, limit))
        }
        "presence" if args.len() == 3 => {
            let now = DateTime::parse_from_rfc3339(&args[2]).map_err(|_| "INVALID_TIME")?;
            Ok(presence(root, now.with_timezone(&Utc)))
        }
        _ => Err("INVALID_ARGUMENTS"),
    }
}

fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(code) => {
            eprintln!("agentchat source rejected: {code}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_token() {
        assert!(token("omb-1234567890", 40));
        assert!(!token("../private", 40));
        assert!(!token("UPPER", 40));
        assert!(!token("", 40));
    }
    #[test]
    fn missing_root_is_unavailable() {
        let missing = Path::new("/nonexistent-singularity-agentchat-dont-create");
        assert_eq!(feed(missing, 0, 80)["available"], false);
    }
    #[test]
    fn clamp_limit_and_cursor() {
        let missing = Path::new("/nonexistent-singularity-agentchat-dont-create");
        assert_eq!(feed(missing, -5, -1)["last_id"], 0);
    }
}
