//! Port of trace_linux_assumptions.py. Matches are source references, never execution proof.
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;
use zip::ZipArchive;

const EXTENSIONS: &[&str] = &[".js", ".mjs", ".cjs", ".py", ".rs", ".ts", ".tsx"];
const PATTERNS: &[(&str, &str)] = &[
    ("linux_proc", r"/proc/(?:\w+|\$|\{)"),
    ("systemd", r"(?i)\bsystemctl\b|\bjournalctl\b|\bsystemd\b"),
    (
        "container_runtime",
        r"(?i)\b(?:docker|podman|docker-compose)\b",
    ),
    ("linux_shell", r"(?i)\b(?:bash|setsid|nohup|sudo|apt-get)\b"),
    ("remote_fleet", r"(?i)\b(?:ssh|scp|rsync)\b"),
    ("unix_socket", r"(?i)\bUnix(?:Listener|Stream)\b|AF_UNIX"),
];

pub fn audit_reader<R: Read + Seek>(
    reader: R,
    archive_name: &str,
    max_occurrences: usize,
) -> Result<Value, String> {
    let mut zip = ZipArchive::new(reader).map_err(|_| "LINUX_AUDIT_BAD_ARCHIVE".to_owned())?;
    let patterns = PATTERNS
        .iter()
        .map(|(name, pattern)| {
            Regex::new(pattern)
                .map(|regex| (*name, regex))
                .map_err(|_| "INVALID_AUDIT_PATTERN".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut findings: BTreeMap<&str, Vec<Value>> = PATTERNS
        .iter()
        .map(|(name, _)| (*name, Vec::new()))
        .collect();
    for i in 0..zip.len() {
        let mut member = zip
            .by_index(i)
            .map_err(|_| "LINUX_AUDIT_CORRUPT_ENTRY".to_owned())?;
        let path = member.name().to_owned();
        if !EXTENSIONS.iter().any(|ext| path.ends_with(ext))
            || path.starts_with("docs/")
            || path.starts_with(".github/")
        {
            continue;
        }
        let mut bytes = Vec::new();
        member
            .read_to_end(&mut bytes)
            .map_err(|_| "LINUX_AUDIT_ENTRY_READ_FAILED".to_owned())?;
        let content = String::from_utf8_lossy(&bytes);
        for (idx, line) in content.lines().enumerate() {
            let trim = line.trim_start();
            if trim.is_empty()
                || trim.starts_with('#')
                || trim.starts_with("//")
                || trim.starts_with('*')
                || trim.starts_with("/*")
            {
                continue;
            }
            for (kind, pattern) in &patterns {
                if pattern.is_match(line) {
                    findings
                        .get_mut(kind)
                        .expect("known pattern")
                        .push(json!({"path":path,"line":idx+1}));
                }
            }
        }
    }
    let mut categories = Map::new();
    let mut total = 0;
    for (kind, _) in PATTERNS {
        let hits = findings.remove(kind).unwrap_or_default();
        total += hits.len();
        categories.insert(
            (*kind).into(),
            json!({"count":hits.len(),
            "sample":hits.iter().take(max_occurrences).collect::<Vec<_>>(),
            "truncated":hits.len()>max_occurrences}),
        );
    }
    Ok(
        json!({"schema":"singularity-native-source-linux-candidates/v1", "archive":archive_name,
        "finding_is_execution_proof":false,"feature_parity_verified":false,"native_release_ready":false,
        "categories":categories,"total_candidates":total,
        "note":"Candidates can be dead code, test fixtures or Windows-guarded paths; require runtime process traces and feature receipts before release."}),
    )
}

pub fn audit(archive: &Path, max_occurrences: usize) -> Result<Value, String> {
    let file = File::open(archive).map_err(|_| "LINUX_AUDIT_ARCHIVE_UNREADABLE".to_owned())?;
    let name = archive
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("LINUX_AUDIT_ARCHIVE_NAME_INVALID")?;
    audit_reader(file, name, max_occurrences)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{write::FileOptions, ZipWriter};
    #[test]
    fn source_matches_do_not_echo_secret_lines() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("harness/main.mjs", FileOptions::default())
            .unwrap();
        zip.write_all(b"// docker inert\nspawnSync(\"docker\", [\"--password=DO_NOT_PRINT_ME\"]);\nconst x = \"/proc/loadavg\";\n").unwrap();
        zip.start_file("docs/README.md", FileOptions::default())
            .unwrap();
        zip.write_all(b"docker").unwrap();
        let stream = zip.finish().unwrap();
        let result = audit_reader(Cursor::new(stream.into_inner()), "fixture.zip", 30).unwrap();
        assert_eq!(result["categories"]["linux_proc"]["count"], 1);
        assert_eq!(result["categories"]["container_runtime"]["count"], 1);
        assert_eq!(result["native_release_ready"], false);
        assert!(!result.to_string().contains("DO_NOT_PRINT_ME"));
        assert!(!result.to_string().contains("README.md"));
    }
}
