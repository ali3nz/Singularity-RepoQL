//! Read-only local memory retrieval / concept-scope audit.
//! Port of the Dockerhost Harness `kit/tools/memory-loop-audit.mjs` reporting
//! subset. No credentials, live queries, data mutations or memory contents.
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 10_000;
const MAX_RECORDS: usize = 2_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
struct Concepts {
    total: usize,
    universal: usize,
    scoped: usize,
    unspecified: usize,
    broad: usize,
    rejected_files: usize,
}

fn local_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("explicit absolute directory required".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "directory unavailable".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("directory unavailable or symbolic link".into());
    }
    Ok(path.to_path_buf())
}

fn yaml_field(frontmatter: &str, field: &str) -> Option<String> {
    for line in frontmatter.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(field) {
                return Some(
                    v.trim()
                        .trim_matches(|ch| ch == '\'' || ch == '"')
                        .to_string(),
                );
            }
        }
    }
    None
}

fn concept_fields(text: &str) -> (bool, bool, bool) {
    let fm = if let Some(frontmatter) = text.strip_prefix("---\n") {
        frontmatter
            .split_once("\n---")
            .map(|(front, _)| front)
            .unwrap_or("")
    } else {
        ""
    };
    let category = yaml_field(fm, "category")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let universal = yaml_field(fm, "universal")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let relevance = yaml_field(fm, "relevance").unwrap_or_default();
    let is_global = category == "principle" || universal == "true";
    let is_scoped = universal == "false" || (!is_global && !relevance.is_empty());
    let broad = relevance.split(';').map(str::trim).any(|p| {
        matches!(
            p,
            "**" | "**/**" | "**/work/**" | "file:///**" | "file:////**" | "file:///"
        )
    });
    (is_global, is_scoped, broad)
}

fn visit(dir: &Path, output: &mut Concepts) -> Result<(), String> {
    if output.total + output.rejected_files >= MAX_FILES {
        return Err("concept file count limit exceeded".into());
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|_| "concept directory unreadable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "concept entry unreadable".to_owned())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|_| "concept metadata unavailable".to_owned())?;
        if meta.file_type().is_symlink() {
            output.rejected_files += 1;
            continue;
        }
        if meta.is_dir() {
            visit(&entry.path(), output)?;
            continue;
        }
        if !meta.is_file() || entry.path().extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
            output.rejected_files += 1;
            continue;
        }
        let body = fs::read_to_string(entry.path())
            .map_err(|_| "concept content unreadable".to_owned())?;
        let (universal, scoped, broad) = concept_fields(&body);
        output.total += 1;
        if universal {
            output.universal += 1;
        } else if scoped {
            output.scoped += 1;
        } else {
            output.unspecified += 1;
        }
        if broad {
            output.broad += 1;
        }
    }
    Ok(())
}

fn retrieval_summary(dir: &Path) -> Result<Value, String> {
    let mut files = fs::read_dir(dir)
        .map_err(|_| "retrieval ledger directory unreadable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "retrieval ledger entry unreadable".to_owned())?;
    files.retain(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"));
    files.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    let mut done = 0usize;
    let mut failed = 0usize;
    let mut injected = 0usize;
    let mut events = 0usize;
    let mut kept = 0usize;
    let mut dropped = 0usize;
    for file in files {
        if events >= MAX_RECORDS {
            break;
        }
        let meta = fs::symlink_metadata(file.path())
            .map_err(|_| "ledger metadata unavailable".to_owned())?;
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let content =
            fs::read_to_string(file.path()).map_err(|_| "ledger unreadable".to_owned())?;
        for line in content.lines().rev() {
            if events >= MAX_RECORDS {
                break;
            }
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match record.get("event").and_then(Value::as_str) {
                Some("retrieval.done") => done += 1,
                Some("retrieval.failed") => failed += 1,
                _ => continue,
            }
            events += 1;
            if record
                .get("injectedBytes")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
            {
                injected += 1;
            }
            kept += record
                .get("kept")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            dropped += record
                .get("dropped")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
        }
    }
    Ok(
        json!({"events":events,"completed":done,"failed":failed,"withInjection":injected,
              "kept":kept,"dropped":dropped,"recordsCapped":events>=MAX_RECORDS}),
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 4 || args[0] != "--concepts-dir" || args[2] != "--ledger-dir" {
        eprintln!(
            "usage: memory_scope_audit --concepts-dir ABSOLUTE_PATH --ledger-dir ABSOLUTE_PATH"
        );
        std::process::exit(2);
    }
    let concepts = local_dir(Path::new(&args[1]))?;
    let ledger = local_dir(Path::new(&args[3]))?;
    let mut summary = Concepts::default();
    visit(&concepts, &mut summary)?;
    let retrieval = retrieval_summary(&ledger)?;
    // No source paths or memory content printed, only bounded numeric counts.
    println!(
        "{}",
        json!({"schema":"windows-memory-audit/1","mode":"read-only",
        "concepts":{"total":summary.total,"universal":summary.universal,
                    "scoped":summary.scoped,"unspecified":summary.unspecified,
                    "broad":summary.broad,"rejectedFiles":summary.rejected_files},
        "retrieval":retrieval,"claim":"aggregate-only; not actual agent recall acceptance"})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_universal_and_scoped_concepts() {
        assert_eq!(
            concept_fields("---\ncategory: principle\n---\nhello"),
            (true, false, false)
        );
        assert_eq!(
            concept_fields("---\ncategory: rule\nrelevance: '**/src/main.rs'\n---"),
            (false, true, false)
        );
        assert_eq!(
            concept_fields("---\nrelevance: '**/**'\n---"),
            (false, true, true)
        );
    }
}
