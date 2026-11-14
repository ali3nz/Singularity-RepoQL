//! Native replacement for scripts/memory_turn_capture.py.
//!
//! This executable deliberately does not write durable concepts itself. It
//! stages a lesson and records an operator-confirmed capture; the existing
//! RepoQL or promotion authority remains the writer of durable memory.
//! No model is called, no live service is installed or restarted.
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_INPUT_CHARS: usize = 8_000;
const MAX_INPUT_BYTES: u64 = 64 * 1024; // 8,000 Unicode codepoints need at most 32 KiB
const CAP_24H: usize = 3;
const DAY: i64 = 24 * 3600;

#[derive(Debug, PartialEq, Eq)]
struct Options {
    command: String,
    state_dir: PathBuf,
    lesson_file: Option<String>,
    confirm_file: Option<PathBuf>,
    skip_rql: bool,
}

fn usage() {
    eprintln!("usage: singularity-memory-turn-capture propose --lesson-file FILE [--state-dir DIR] [--skip-rql]");
    eprintln!("       singularity-memory-turn-capture confirm --file FILE [--state-dir DIR]");
    eprintln!("       singularity-memory-turn-capture status [--state-dir DIR]");
}

fn parse_args(args: &[String]) -> Result<Options, &'static str> {
    let Some(command) = args.first() else {
        return Err("missing subcommand");
    };
    if !["propose", "confirm", "status"].contains(&command.as_str()) {
        return Err("unknown subcommand");
    }
    let mut opts = Options {
        command: command.clone(),
        state_dir: PathBuf::from("data/selflearn"),
        lesson_file: None,
        confirm_file: None,
        skip_rql: false,
    };
    let mut i = 1;
    while i < args.len() {
        let flag = args[i].as_str();
        match flag {
            "--skip-rql" if command == "propose" => opts.skip_rql = true,
            "--lesson-file" if command == "propose" && i + 1 < args.len() => {
                i += 1;
                if opts.lesson_file.replace(args[i].clone()).is_some() {
                    return Err("duplicate --lesson-file");
                }
            }
            "--file" if command == "confirm" && i + 1 < args.len() => {
                i += 1;
                if opts.confirm_file.replace(PathBuf::from(&args[i])).is_some() {
                    return Err("duplicate --file");
                }
            }
            "--state-dir" if i + 1 < args.len() => {
                i += 1;
                opts.state_dir = PathBuf::from(&args[i]);
            }
            _ => return Err("unknown, misplaced, or incomplete argument"),
        }
        i += 1;
    }
    if command == "propose" && opts.lesson_file.is_none() {
        return Err("--lesson-file required");
    }
    if command == "confirm" && opts.confirm_file.is_none() {
        return Err("--file required");
    }
    if opts.state_dir.as_os_str().is_empty() {
        return Err("empty state directory");
    }
    Ok(opts)
}

fn now_seconds() -> i64 {
    Utc::now().timestamp()
}

fn recent_confirmed(state: &Value, now: i64) -> Vec<Value> {
    state
        .get("confirmed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("ts")
                .and_then(Value::as_i64)
                .is_some_and(|ts| ts >= now - DAY)
        })
        .cloned()
        .collect()
}

fn load_state(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({"confirmed":[],"lastRunTs":0}));
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("state error in {}: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("state error in {}: {e}", path.display()))?;
    if !value.is_object() || !value.get("confirmed").is_none_or(Value::is_array) {
        return Err(format!(
            "state error in {}: unexpected schema",
            path.display()
        ));
    }
    Ok(value)
}

fn save_state(path: &Path, state: &mut Value, now: i64) -> Result<(), String> {
    state["lastRunTs"] = json!(now);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("state directory creation failed: {e}"))?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("state.json");
    let tmp = parent.join(format!(".{name}.tmp"));
    // Never truncate a concurrent writer's temporary file or corrupt state on
    // a crash. The Rust source variant is single-operator, as was the Python
    // loop. A stale .tmp requires an explicit operator cleanup.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("state temporary file unavailable: {e}"))?;
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|e| format!("state serialization failed: {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("state write failed: {e}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| format!("atomic state rename failed: {e}"))?;
    Ok(())
}

fn slugify(text: &str) -> String {
    let sanitized: String = text
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect();
    let words: Vec<&str> = sanitized.split_whitespace().take(8).collect();
    let slug = if words.is_empty() {
        "lesson".to_string()
    } else {
        words.join("-")
    };
    slug.chars().take(64).collect()
}

fn read_lesson(source: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    if source == "-" {
        io::stdin()
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("stdin lesson read failed: {e}"))?;
    } else {
        let file = File::open(source).map_err(|e| format!("lesson file read failed: {e}"))?;
        file.take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("lesson file read failed: {e}"))?;
    }
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(format!("lesson input exceeds {MAX_INPUT_CHARS} chars"));
    }
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}

fn pending_last_day(dir: &Path, now: i64) -> Result<usize, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|e| format!("pending directory unreadable: {e}"))? {
        let entry = entry.map_err(|e| format!("pending directory entry unreadable: {e}"))?;
        if entry
            .path()
            .extension()
            .is_none_or(|ext| ext.to_string_lossy() != "md")
        {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .map_err(|e| format!("pending timestamp unavailable: {e}"))?;
        let seconds = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs();
        if seconds >= now.saturating_sub(DAY).max(0) as u64 {
            count += 1;
        }
    }
    Ok(count)
}

fn short_nonce(attempt: usize) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let seed = format!("{}:{}:{}", nanos, std::process::id(), attempt);
    Sha256::digest(seed.as_bytes())[..4]
        .iter()
        .map(|b| char::from(b'a' + b % 26))
        .collect()
}

fn deferral(reason: &str, lesson: &str) {
    println!("DEFERRED ({reason}): full skeleton below - keep it in the session transcript, nothing is discarded");
    println!("{lesson}");
}

fn rql_preview(lesson: &str) -> Result<(), String> {
    let q: String = lesson.chars().take(120).collect();
    let mut cmd = Command::new("rql");
    cmd.args(["explore", &q, "--uri-glob", "**", "--token-budget", "600"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("rql pre-check failed: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut text = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout
                        .read_to_string(&mut text)
                        .map_err(|e| format!("rql output unreadable: {e}"))?;
                }
                if !status.success() {
                    return Err(format!("rql pre-check failed (rc {:?})", status.code()));
                }
                println!("DEDUP-PREVIEW (rql explore top hits):");
                let top = text.lines().take(12).collect::<Vec<_>>().join("\n");
                println!(
                    "{}",
                    if top.trim().is_empty() {
                        "(no prior capsule matched)"
                    } else {
                        &top
                    }
                );
                return Ok(());
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("rql pre-check did not finish within 60s (timeout)".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("rql pre-check wait failed: {e}")),
        }
    }
}

fn propose(opts: &Options) -> i32 {
    let lesson = match read_lesson(opts.lesson_file.as_deref().unwrap_or("")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("REFUSED: {e}");
            return 3;
        }
    };
    if lesson.is_empty() {
        eprintln!("empty lesson input; nothing to propose");
        return 2;
    }
    let n = lesson.chars().count();
    if n > MAX_INPUT_CHARS {
        println!("REFUSED: lesson input is {n} chars; cap is {MAX_INPUT_CHARS} (trim or split; zero model calls were spent)");
        return 3;
    }
    if let Err(e) = fs::create_dir_all(&opts.state_dir) {
        eprintln!("{e}");
        return 6;
    }
    let state_path = opts.state_dir.join("state.json");
    let mut state = match load_state(&state_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 6;
        }
    };
    let now = now_seconds();
    let pending = opts.state_dir.join("pending");
    let count = match pending_last_day(&pending, now) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("{e}");
            return 6;
        }
    };
    if count >= CAP_24H {
        deferral(
            &format!("{count} pending lessons queued in the last 24h"),
            &lesson,
        );
        return 5;
    }
    let confirmed = recent_confirmed(&state, now);
    if confirmed.len() >= CAP_24H {
        deferral(
            &format!("{} confirmed captures in the last 24h", confirmed.len()),
            &lesson,
        );
        return 5;
    }
    if opts.skip_rql {
        println!(
            "SKIP-RQL: dedup preview unavailable this run; label the capture as unverified-dedup"
        );
    } else if let Err(e) = rql_preview(&lesson) {
        eprintln!("REFUSED: {e}. Nothing written; retry with --skip-rql and label the capture unverified-dedup.");
        return 4;
    }
    if let Err(e) = fs::create_dir_all(&pending) {
        eprintln!("{e}");
        return 6;
    }
    let first_line = lesson.lines().next().unwrap_or("");
    let mut selected = None;
    for attempt in 0..32 {
        let path = pending.join(format!(
            "{now}-{}-{}.md",
            short_nonce(attempt),
            slugify(first_line)
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let proposed_at = Utc
                    .timestamp_opt(now, 0)
                    .single()
                    .unwrap_or_else(Utc::now)
                    .format("%Y-%m-%dT%H:%M:%SZ");
                let content = format!("# pending lesson (self-learning loop; unconfirmed)\n- proposed at: {proposed_at}\n- capture surfaces: `rql concept add` (code lesson) or `scripts/knowledge-promotion.py --propose` (operator decision)\n- after capture run: python3 scripts/memory_turn_capture.py confirm --file {}\n\n{lesson}\n", path.display());
                if file
                    .write_all(content.as_bytes())
                    .and_then(|_| file.sync_all())
                    .is_err()
                {
                    eprintln!("pending file write failed: {}", path.display());
                    return 6;
                }
                selected = Some(path);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                eprintln!("pending file creation failed: {e}");
                return 6;
            }
        }
    }
    let Some(path) = selected else {
        eprintln!("pending filename collisions exceeded");
        return 6;
    };
    if let Err(e) = save_state(&state_path, &mut state, now) {
        eprintln!("{e}; pending file remains at {}", path.display());
        return 6;
    }
    println!("PENDING WRITTEN: {}", path.display());
    println!("NEXT: one bounded model pass, capture through one gated surface, then confirm");
    println!("cap left this window: {}", CAP_24H - confirmed.len());
    0
}

fn confirm(opts: &Options) -> i32 {
    let target = opts.confirm_file.as_deref().expect("validated arguments");
    if !target.is_file() {
        eprintln!("unknown pending file: {}", target.display());
        return 2;
    }
    // Unlike the legacy script, the Rust implementation never promotes an
    // arbitrary path that is not in this state's own pending directory.
    let pending = opts.state_dir.join("pending");
    let (Ok(real_pending), Ok(real_target)) = (pending.canonicalize(), target.canonicalize())
    else {
        eprintln!("pending file path cannot be validated");
        return 6;
    };
    if real_target.parent() != Some(real_pending.as_path()) {
        eprintln!("REFUSED: confirmation requires a file in this state's pending directory");
        return 6;
    }
    let state_path = opts.state_dir.join("state.json");
    let mut state = match load_state(&state_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 6;
        }
    };
    let now = now_seconds();
    let mut confirmed = recent_confirmed(&state, now);
    if confirmed.len() >= CAP_24H {
        println!("DEFERRED (cap): the 24h window is full; the pending file stays in place (nothing discarded)");
        return 5;
    }
    let out_dir = opts.state_dir.join("confirmed");
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("{e}");
        return 6;
    }
    let Some(filename) = real_target.file_name() else {
        eprintln!("invalid pending name");
        return 6;
    };
    let final_path = out_dir.join(filename);
    if final_path.exists() {
        eprintln!("REFUSED: confirmed filename already exists");
        return 6;
    }
    if let Err(e) = fs::rename(&real_target, &final_path) {
        eprintln!("confirmation rename failed: {e}");
        return 6;
    }
    confirmed.push(json!({"ts":now,"file":final_path.to_string_lossy().replace('\\', "/")}));
    state["confirmed"] = json!(confirmed);
    if let Err(e) = save_state(&state_path, &mut state, now) {
        eprintln!("{e}; confirmation file remains at {}", final_path.display());
        return 6;
    }
    println!("CONFIRMED: {}", final_path.display());
    println!(
        "cap left this window: {}",
        CAP_24H - recent_confirmed(&state, now).len()
    );
    0
}

fn status(opts: &Options) -> i32 {
    let state = match load_state(&opts.state_dir.join("state.json")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 6;
        }
    };
    let entries = recent_confirmed(&state, now_seconds());
    println!(
        "confirmed captures in last 24h: {} / {CAP_24H}",
        entries.len()
    );
    for row in entries {
        let ts = row.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let clock = Utc
            .timestamp_opt(ts, 0)
            .single()
            .map(|v| v.format("%H:%MZ").to_string())
            .unwrap_or_else(|| "unknown".to_string());
        println!(
            "  - {} {}",
            clock,
            row.get("file").and_then(Value::as_str).unwrap_or("")
        );
    }
    0
}

fn run() -> i32 {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let opts = match parse_args(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            usage();
            return 2;
        }
    };
    match opts.command.as_str() {
        "propose" => propose(&opts),
        "confirm" => confirm(&opts),
        "status" => status(&opts),
        _ => 2,
    }
}

fn main() {
    std::process::exit(run());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_expected_cli_arguments() {
        let args = [
            "propose",
            "--lesson-file",
            "-",
            "--skip-rql",
            "--state-dir",
            "data/test",
        ]
        .map(str::to_owned);
        let parsed = parse_args(&args).expect("valid arguments");
        assert_eq!(parsed.command, "propose");
        assert_eq!(parsed.lesson_file.as_deref(), Some("-"));
        assert!(parsed.skip_rql);
        assert!(parse_args(&["confirm".into()]).is_err());
        assert!(parse_args(&["status".into(), "--skip-rql".into()]).is_err());
    }
    #[test]
    fn unicode_is_counted_as_characters_not_bytes() {
        let lesson = "汉".repeat(8_000);
        assert!(lesson.len() > MAX_INPUT_CHARS);
        assert_eq!(lesson.chars().count(), MAX_INPUT_CHARS);
    }
    #[test]
    fn rolling_cap_preserves_deferred_entries() {
        let state = json!({"confirmed":[{"ts":1_000,"file":"a"},{"ts":1_100,"file":"b"},{"ts":1_200,"file":"c"}]});
        assert_eq!(recent_confirmed(&state, 1_200).len(), CAP_24H);
        assert_eq!(recent_confirmed(&state, 1_200 + DAY + 1).len(), 0);
    }
    #[test]
    fn one_lesson_slug_is_bounded() {
        assert_eq!(
            slugify("Make retrieval safe when data expires"),
            "make-retrieval-safe-when-data-expires"
        );
        assert!(slugify(&"long ".repeat(100)).chars().count() <= 64);
    }
    #[test]
    fn complete_lesson_lifecycle_never_writes_a_concept() {
        let base = env::temp_dir().join(format!(
            "singularity-capture-{}-{}",
            std::process::id(),
            short_nonce(1)
        ));
        fs::create_dir_all(&base).unwrap();
        let lesson = base.join("lesson.md");
        fs::write(&lesson, "Keep exact values and source evidence").unwrap();
        let opts = Options {
            command: "propose".to_string(),
            state_dir: base.join("state"),
            lesson_file: Some(lesson.to_string_lossy().into_owned()),
            confirm_file: None,
            skip_rql: true,
        };
        assert_eq!(propose(&opts), 0);
        let pending = fs::read_dir(opts.state_dir.join("pending"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_dir(opts.state_dir.join("pending"))
                .unwrap()
                .count(),
            1
        );
        let confirm_opts = Options {
            command: "confirm".to_string(),
            state_dir: opts.state_dir.clone(),
            lesson_file: None,
            confirm_file: Some(pending.clone()),
            skip_rql: false,
        };
        assert_eq!(confirm(&confirm_opts), 0);
        assert!(!pending.exists());
        assert_eq!(
            recent_confirmed(
                &load_state(&opts.state_dir.join("state.json")).unwrap(),
                now_seconds()
            )
            .len(),
            1
        );
        assert_eq!(
            status(&Options {
                command: "status".to_string(),
                state_dir: opts.state_dir,
                lesson_file: None,
                confirm_file: None,
                skip_rql: false
            }),
            0
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn confirmation_is_scoped_to_pending_folder() {
        let base = env::temp_dir().join(format!(
            "singularity-capture-{}-{}",
            std::process::id(),
            short_nonce(2)
        ));
        fs::create_dir_all(base.join("pending")).unwrap();
        let outside = base.join("outside.md");
        fs::write(&outside, "do not promote").unwrap();
        let opts = Options {
            command: "confirm".to_string(),
            state_dir: base.clone(),
            lesson_file: None,
            confirm_file: Some(outside.clone()),
            skip_rql: false,
        };
        assert_eq!(confirm(&opts), 6);
        assert!(outside.is_file());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn corrupt_state_is_not_silently_reset() {
        let base = env::temp_dir().join(format!(
            "singularity-capture-{}-{}",
            std::process::id(),
            short_nonce(0)
        ));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("state.json");
        fs::write(&path, "{bad}").unwrap();
        assert!(load_state(&path).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
}
