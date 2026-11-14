//! Read-only native replacements for four Windows Singularity evidence policy utilities.
//! No service startup, file deletion, installation, token handling or modification.
use chrono::{DateTime, Utc};
use serde_json::Value;
use singularity_release_evidence::{
    acceptance, connector_inventory, doc_impact, linux_candidates, parity, rust_locks, upgrade,
};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

fn flags(args: &[String], accepted: &[&str]) -> Result<BTreeMap<String, String>, &'static str> {
    let (pairs, remainder) = args.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("INVALID_ARGUMENTS");
    }
    let mut result = BTreeMap::new();
    for pair in pairs {
        if !accepted.contains(&pair[0].as_str())
            || result.insert(pair[0].clone(), pair[1].clone()).is_some()
        {
            return Err("INVALID_ARGUMENTS");
        }
    }
    Ok(result)
}
fn flag<'a>(args: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, &'static str> {
    args.get(name).map(String::as_str).ok_or("MISSING_ARGUMENT")
}
fn read_json(path: &str) -> Result<Value, &'static str> {
    let bytes = fs::read(path).map_err(|_| "SOURCE_UNREADABLE")?;
    serde_json::from_slice(&bytes).map_err(|_| "SOURCE_INVALID_JSON")
}
fn process(args: &[String]) -> Result<(Value, bool, Option<String>), &'static str> {
    let command = args.first().map(String::as_str).ok_or("MISSING_COMMAND")?;
    match command {
        "parity" => {
            let opts = flags(
                &args[1..],
                &[
                    "--production",
                    "--windows",
                    "--now",
                    "--max-age-days",
                    "--output",
                ],
            )?;
            let prod = read_json(flag(&opts, "--production")?)?;
            let win = read_json(flag(&opts, "--windows")?)?;
            let now = match opts.get("--now") {
                Some(v) => DateTime::parse_from_rfc3339(v)
                    .map_err(|_| "INVALID_NOW")?
                    .with_timezone(&Utc),
                None => Utc::now(),
            };
            let age = match opts.get("--max-age-days") {
                Some(v) => v.parse::<i64>().map_err(|_| "INVALID_MAX_AGE")?,
                None => 7,
            };
            if !(0..=3650).contains(&age) {
                return Err("INVALID_MAX_AGE");
            }
            let report = parity::compare(&prod, &win, now, age);
            let ok = report["ready"] == true;
            Ok((report, ok, opts.get("--output").cloned()))
        }
        "linux-candidates" => {
            let archive = args.get(1).ok_or("MISSING_ARCHIVE")?;
            let opts = flags(&args[2..], &["--output", "--max-occurrences"])?;
            let max = match opts.get("--max-occurrences") {
                Some(v) => v.parse::<usize>().map_err(|_| "INVALID_MAX_OCCURRENCES")?,
                None => 30,
            };
            if max > 10000 {
                return Err("INVALID_MAX_OCCURRENCES");
            }
            let report = linux_candidates::audit(Path::new(archive), max)
                .map_err(|_| "ARCHIVE_AUDIT_FAILED")?;
            Ok((report, true, opts.get("--output").cloned()))
        }
        "rust-lock" => {
            let opts = flags(&args[1..], &["--source-root", "--output"])?;
            let report = rust_locks::inspect(Path::new(flag(&opts, "--source-root")?));
            let ok = report["readyForRustDependencyReview"] == true;
            Ok((report, ok, opts.get("--output").cloned()))
        }
        "doc-impact-stdin" | "doc-render-stdin" => {
            if args.len() != 1 {
                return Err("INVALID_ARGUMENTS");
            }
            const CAP: u64 = 256 * 1024;
            let mut input = Vec::new();
            io::stdin()
                .take(CAP + 1)
                .read_to_end(&mut input)
                .map_err(|_| "SOURCE_UNREADABLE")?;
            if input.len() as u64 > CAP {
                return Err("INPUT_LIMIT");
            }
            let data: Value = serde_json::from_slice(&input).map_err(|_| "SOURCE_INVALID_JSON")?;
            let report = if command == "doc-impact-stdin" {
                doc_impact::classify(data.get("changedFiles").ok_or("MISSING_CHANGED_FILES")?)?
            } else {
                serde_json::json!({"report":doc_impact::render(data.get("classification").ok_or("MISSING_CLASSIFICATION")?)?})
            };
            Ok((report, true, None))
        }
        "upgrade-plan-stdin" | "acceptance-matrix-stdin" => {
            if args.len() != 1 {
                return Err("INVALID_ARGUMENTS");
            }
            // Pure policy projection. Trusted Python owns receipt/scheduler
            // validation; no paths, secrets, filenames or raw logs cross stdin.
            const CAP: u64 = 64 * 1024;
            let mut input = Vec::new();
            io::stdin()
                .take(CAP + 1)
                .read_to_end(&mut input)
                .map_err(|_| "SOURCE_UNREADABLE")?;
            if input.len() as u64 > CAP {
                return Err("INPUT_LIMIT");
            }
            let data: Value = serde_json::from_slice(&input).map_err(|_| "SOURCE_INVALID_JSON")?;
            let report = if command == "upgrade-plan-stdin" {
                upgrade::evaluate(&data)?
            } else {
                acceptance::evaluate(&data)?
            };
            // A valid evaluation returns 0 even if the plan is blocked or
            // every acceptance gate reports FAIL / NOT_RUN.
            Ok((report, true, None))
        }
        "connector-evaluate-stdin" => {
            if args.len() != 1 {
                return Err("INVALID_ARGUMENTS");
            }
            // The trusted Python collector supplies the actual local inventory.
            // This CLI never queries a connector and cannot claim a live proof.
            const CAP: u64 = 256 * 1024;
            let mut input = Vec::new();
            io::stdin()
                .take(CAP + 1)
                .read_to_end(&mut input)
                .map_err(|_| "SOURCE_UNREADABLE")?;
            if input.len() as u64 > CAP {
                return Err("INPUT_LIMIT");
            }
            let inventory: Value =
                serde_json::from_slice(&input).map_err(|_| "SOURCE_INVALID_JSON")?;
            let report = connector_inventory::evaluate(&inventory);
            let ok = report["bothConnectorsActive"] == true;
            Ok((report, ok, None))
        }
        "connector-evaluate" => {
            let opts = flags(&args[1..], &["--inventory", "--output"])?;
            let inventory = read_json(flag(&opts, "--inventory")?)?;
            let report = connector_inventory::evaluate(&inventory);
            // Mirrors connector inventory CLI: incomplete inventory is a refused check.
            let ok = report["bothConnectorsActive"] == true;
            Ok((report, ok, opts.get("--output").cloned()))
        }
        _ => Err("UNKNOWN_COMMAND"),
    }
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match process(&args) {
        Ok((report, success, output)) => {
            let json = format!(
                "{}\n",
                serde_json::to_string_pretty(&report).expect("serializable report")
            );
            if let Some(path) = output {
                if fs::write(&path, json.as_bytes()).is_err() {
                    eprintln!("RELEASE_EVIDENCE_REFUSED:OUTPUT_WRITE_FAILED");
                    std::process::exit(2);
                }
            } else {
                print!("{json}");
            }
            if !success {
                std::process::exit(2);
            }
        }
        Err(code) => {
            eprintln!("RELEASE_EVIDENCE_REFUSED:{code}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_preserve_pairs_and_refuse_malformed_unknown_or_duplicate_options() {
        let accepted = ["--one", "--two"];
        assert!(flags(&[], &accepted).unwrap().is_empty());
        for bad in [
            vec!["--one"],
            vec!["--one", "first", "--two"],
            vec!["--unknown", "value"],
            vec!["--one", "first", "--one", "second"],
        ] {
            let args: Vec<String> = bad.into_iter().map(String::from).collect();
            assert_eq!(flags(&args, &accepted), Err("INVALID_ARGUMENTS"));
        }
        let args = ["--two", "second", "--one", "first"].map(String::from);
        let parsed = flags(&args, &accepted).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["--one"], "first");
        assert_eq!(parsed["--two"], "second");
    }
}
