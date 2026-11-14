//! Source-only native CLI for safely usable, read-only leaf policies.
//! Task recovery is intentionally NOT exposed: only a trusted Kanzo-bound
//! Windows integration may call that library function.
use serde_json::{json, Value};
use singularity_memory_parity::{
    answerability, authority, candidate_lifecycle, candidate_policy, conflict_signals,
    document_learning, hook_capture, lineage, main_proxy, memory_impact, payload_budget, promotion,
    ranking, reconcile, source_policy, synthesis_spec, task_recovery, temporal, tombstone,
    windows_acceptance,
};
use std::collections::HashMap;
use std::io::{self, Read};
use std::path::Path;

// Mirror the existing JavaScript `Number.isFinite(limit) ? Math.floor(limit) : 3`
// then Math.max(1, Math.min(10, ...)). Missing values use the contract
// default for that layer; explicit non-numbers fall back to 3.
fn task_recovery_limit(value: Option<&Value>, default: i64) -> i64 {
    match value {
        None => default,
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|n| n.floor().clamp(1.0, 10.0) as i64)
            .unwrap_or(3),
        Some(_) => 3,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("preflight") {
        if args.get(2).map(String::as_str) != Some("--root")
            || args.get(3).is_none()
            || args.len() != 4
        {
            eprintln!("usage: singularity-memory-parity preflight --root PATH");
            std::process::exit(2);
        }
        let env: HashMap<String, String> = std::env::vars().collect();
        let result = authority::inspect(Path::new(&args[3]), &env);
        println!("{result}");
        std::process::exit(if result["ok"] == true { 0 } else { 2 });
    }
    // Match the Node policy bridge's 256 KiB request cap. The executable is
    // also a standalone CLI, so its input cannot rely on the caller's limit.
    const INPUT_CAP: u64 = 256 * 1024;
    let mut body = String::new();
    if io::stdin()
        .take(INPUT_CAP + 1)
        .read_to_string(&mut body)
        .is_err()
        || body.len() as u64 > INPUT_CAP
    {
        println!("{}", json!({"ok":false,"code":"INVALID_INPUT"}));
        std::process::exit(2);
    }
    let input: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            println!("{}", json!({"ok":false,"code":"INVALID_INPUT"}));
            std::process::exit(2);
        }
    };
    let result = match args.get(1).map(String::as_str) {
        Some(
            "contradiction-signal" | "numeric-divergence" | "parse-capsule" | "extract-invariant",
        ) => conflict_signals::evaluate(args[1].as_str(), &input),
        Some("doc-index-chunks") => singularity_memory_parity::doc_ingest::chunk_request(&input),
        Some("doc-index-plan") => singularity_memory_parity::doc_ingest::write_plan(&input),
        Some("doc-index-locate") => singularity_memory_parity::doc_ingest::locate_entry(&input),
        Some("doc-index-select") => singularity_memory_parity::doc_ingest::select_retrieval(&input),
        Some("doc-policy-classify") => document_learning::classify(&input),
        Some("doc-root-entries") => document_learning::doc_roots(&input),
        Some("selflearn-candidate-id") => document_learning::candidate_id(&input),
        Some("selflearn-validate-lesson") => document_learning::validate_lesson(&input),
        Some("promotion-shortlist") => promotion::shortlist(&input),
        Some("promotion-advance") => promotion::advance(&input),
        Some("promotion-eligibility") => promotion::eligibility(&input),
        Some("main-memory-state") => main_proxy::offline_state(&input),
        Some("main-memory-plan") => main_proxy::integration_plan(&input),
        Some("main-memory-uninstall") => main_proxy::uninstall_plan(&input),
        Some("delegated-identity") => windows_acceptance::delegated_map(&input),
        Some("doc-reconcile-action") => windows_acceptance::document_action(&input),
        Some("repoql-doc-uri") => windows_acceptance::repoql_doc_uri(&input),
        Some("hook-redact") => hook_capture::redact_request(&input),
        Some("hook-capture-id") => hook_capture::capture_id_request(&input),
        Some("answerability-packet") => {
            json!({"ok":true,"value":answerability::judge_packet(&input)})
        }
        Some("answerability-expanded") => {
            json!({"ok":true,"value":answerability::judge_expanded(&input)})
        }
        Some("answerability-conflicts") => {
            json!({"ok":true,"value":answerability::detect_conflicts(&input)})
        }
        Some("reconcile-missing") => reconcile::missing_indices(&input),
        Some("synthesis-validate") => synthesis_spec::validate(&input),
        Some("lineage-filter") => lineage::filter_record_names(&input),
        Some("lineage-graph") => lineage::inspect_graph(&input),
        Some("candidate-policy") => candidate_policy::assess(&input),
        Some("candidate-transition") => candidate_lifecycle::transition(&input),
        Some("candidate-ttl") => candidate_lifecycle::ttl(&input),
        Some("memory-impact-files") => {
            // This command receives only caller-selected, trusted filenames.
            // An unreadable file is a hard error: treating it as empty would
            // silently underreport stale knowledge during a REVIEW stage.
            const MAX_KNOWLEDGE_FILE_BYTES: u64 = 1024 * 1024;
            const MAX_TOTAL_KNOWLEDGE_BYTES: u64 = 12 * 1024 * 1024;
            let mut request = input.clone();
            let mut files = Vec::new();
            let mut failure = None;
            let mut total_bytes = 0_u64;
            if let Some(paths) = input.get("files").and_then(Value::as_array) {
                for entry in paths {
                    let Some(file) = entry.as_str() else {
                        failure = Some("INVALID_KNOWLEDGE_FILE_PATH");
                        break;
                    };
                    let meta = match std::fs::metadata(file) {
                        Ok(m) if m.is_file() => m,
                        _ => {
                            failure = Some("KNOWLEDGE_FILE_UNREADABLE");
                            break;
                        }
                    };
                    if meta.len() > MAX_KNOWLEDGE_FILE_BYTES
                        || total_bytes.saturating_add(meta.len()) > MAX_TOTAL_KNOWLEDGE_BYTES
                    {
                        failure = Some("KNOWLEDGE_FILE_BUDGET_EXCEEDED");
                        break;
                    }
                    let content = match std::fs::read_to_string(file) {
                        Ok(content) => content,
                        Err(_) => {
                            failure = Some("KNOWLEDGE_FILE_UNREADABLE");
                            break;
                        }
                    };
                    total_bytes = total_bytes.saturating_add(content.len() as u64);
                    if total_bytes > MAX_TOTAL_KNOWLEDGE_BYTES {
                        failure = Some("KNOWLEDGE_FILE_BUDGET_EXCEEDED");
                        break;
                    }
                    files.push(json!({"file":file,"content":content}));
                }
            } else {
                failure = Some("INVALID_KNOWLEDGE_FILE_LIST");
            }
            match failure {
                Some(code) => json!({"ok":false,"code":code}),
                None => {
                    request["knowledgeFiles"] = json!(files);
                    memory_impact::impact(&request)
                }
            }
        }
        Some("memory-impact") => memory_impact::impact(&input),
        Some("payload-budget") => payload_budget::budget(&input),
        Some("split-bytes") => {
            let body = input.get("text").and_then(Value::as_str).unwrap_or("");
            let cap = input
                .get("cap")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(payload_budget::ATTACH_PER_FILE_BYTES);
            match payload_budget::split_into_byte_parts(body, cap) {
                Ok(parts) => json!({"ok":true,"parts":parts}),
                Err(reason) => json!({"ok":false,"code":"INVALID_CAP","reason":reason}),
            }
        }
        Some("rank") => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            let rows = input
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            json!({"ok":true,"results":ranking::live_source_order(rows, query)})
        }
        Some("temporal") => match temporal::check(&input) {
            Ok(v) => v,
            Err(e) => json!({"ok":false,"code":"INVALID_TEMPORAL_METADATA","detail":e}),
        },
        Some("tombstone-claim") => {
            let rows = input
                .get("tombstones")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let claim = input.get("claim").and_then(Value::as_str).unwrap_or("");
            let scope = input.get("scope").and_then(Value::as_str);
            let index = tombstone::rejected_claim_index(claim, scope, rows);
            json!({"ok":true,"blocked":index.is_some(),"matchedIndex":index})
        }
        Some("tombstone-check") => {
            let rows = input
                .get("tombstones")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let subject = input.get("subject").and_then(Value::as_str).unwrap_or("");
            let field = input.get("field").and_then(Value::as_str).unwrap_or("");
            let claim = input.get("claim").and_then(Value::as_str).unwrap_or("");
            let scope = input.get("scope").and_then(Value::as_str);
            let index = tombstone::matching_rejection_index(subject, field, claim, scope, rows);
            json!({"ok":true,"blocked":index.is_some(),"matchedIndex":index})
        }
        Some("source-policy") => {
            let name = input.get("name").and_then(Value::as_str).unwrap_or("");
            let variant = input
                .get("variant")
                .and_then(Value::as_u64)
                .and_then(|v| u8::try_from(v).ok())
                .unwrap_or(0);
            match source_policy::windows_variant_excludes(name, variant) {
                Ok(excluded) => json!({"ok":true,
                    "windowsSafeMember":source_policy::windows_safe_member(name),
                    "retired":source_policy::windows_retired_source(name),
                    "office":source_policy::windows_office_source(name),
                    "linuxAsset":source_policy::linux_deployment_asset(name),
                    "excluded":excluded,
                }),
                Err(_) => json!({"ok":false,"code":"INVALID_VARIANT"}),
            }
        }
        // Pure post-authorization formatter only. The CLI cannot reach Kanzo,
        // the capture ledger, or MemoryCore; those checks and reads remain with
        // the trusted caller. `authorizationVerified` is only a caller assertion
        // and must never be used as an authorization mechanism by itself.
        Some("task-recovery-snapshot") => {
            let result = task_recovery::recover_from_verified_snapshots(
                input.get("ledger").unwrap_or(&Value::Null),
                input.get("taskId").and_then(Value::as_str).unwrap_or(""),
                input.get("agent").and_then(Value::as_str).unwrap_or(""),
                input.get("identity").unwrap_or(&Value::Null),
                input.get("query").and_then(Value::as_str).unwrap_or(""),
                input.get("authorizationVerified").and_then(Value::as_bool) == Some(true),
                input.get("l1Response").unwrap_or(&Value::Null),
                input.get("l0Response").unwrap_or(&Value::Null),
                input
                    .get("maxUnits")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(30),
                task_recovery_limit(input.get("l1Limit"), 5),
                task_recovery_limit(input.get("l0Limit"), 3),
            );
            // A no-evidence result is a valid, complete policy result, not a
            // failing process or a reason for the Node bridge to fall back.
            json!({"ok":true,"value":result})
        }
        Some("task-links") => {
            let task_id = input.get("taskId").and_then(Value::as_str).unwrap_or("");
            let agent = input.get("agent").and_then(Value::as_str).unwrap_or("");
            let ledger = input.get("ledger").unwrap_or(&Value::Null);
            json!({"ok":true,"units":task_recovery::linked_capture_units(ledger, task_id, agent)})
        }
        _ => json!({"ok":false,"code":"UNKNOWN_COMMAND"}),
    };
    println!("{result}");
    // A budget calculation may legitimately exclude files and return ok:false
    // with a complete omission manifest. That is NOT a CLI transport failure.
    let budget_omission = args.get(1).map(String::as_str) == Some("payload-budget")
        && result["ok"] == false
        && result["omitted"].is_array()
        && result["included"].is_array()
        && result["reasons"].is_array();
    if result["ok"] != true && !budget_omission {
        std::process::exit(2);
    }
}

#[cfg(test)]
mod task_snapshot_cli_tests {
    use super::*;
    #[test]
    fn layer_limits_match_existing_js_finite_floor_and_clip() {
        assert_eq!(task_recovery_limit(None, 5), 5);
        assert_eq!(task_recovery_limit(Some(&json!(4.9)), 5), 4);
        assert_eq!(task_recovery_limit(Some(&json!(0.1)), 5), 1);
        assert_eq!(task_recovery_limit(Some(&json!(999)), 3), 10);
        assert_eq!(task_recovery_limit(Some(&Value::Null), 5), 3);
        assert_eq!(task_recovery_limit(Some(&json!("4")), 5), 3);
    }
}
