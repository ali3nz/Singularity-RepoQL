//! Deterministic documentation chunking and MemoryCore write-envelope planning.
//!
//! The canonical document, allowlist, credential screening, network writes,
//! revision ledger and verified search readback remain with the trusted Python
//! document ingester. A native result is usable only after exact Python parity.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_CHARS: usize = 7000;
const MAX_CHUNKS: usize = 64;
const MAX_DOC_BYTES: usize = 200 * 1024;

fn failure(code: &str) -> Value {
    json!({"ok":false,"code":code})
}

/// Python `str.splitlines()` semantics, including CRLF and Unicode separators.
fn python_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut chars = text.char_indices().peekable();
    let mut start = 0;
    while let Some((index, ch)) = chars.next() {
        let is_boundary = matches!(
            ch,
            '\n' | '\r'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{001c}'
                | '\u{001d}'
                | '\u{001e}'
                | '\u{0085}'
                | '\u{2028}'
                | '\u{2029}'
        );
        if !is_boundary {
            continue;
        }
        lines.push(&text[start..index]);
        let mut end = index + ch.len_utf8();
        if ch == '\r' && matches!(chars.peek(), Some((_, '\n'))) {
            if let Some((n, _)) = chars.next() {
                end = n + 1;
            }
        }
        start = end;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

fn flush(out: &mut Vec<String>, current: &mut Vec<String>, char_count: &mut usize) {
    if !current.is_empty() {
        out.push(current.join("\n"));
        current.clear();
        *char_count = 0;
    }
}

fn heading(line: &str) -> bool {
    line.starts_with("# ") || line.starts_with("## ") || line.starts_with("### ")
}

fn trimmed_fence(line: &str) -> bool {
    line.trim_matches(|ch: char| ch.is_whitespace() || ('\u{001c}'..='\u{001f}').contains(&ch))
        .starts_with("```")
}

/// Fully bounded and non-truncating Markdown chunks. Forced splits of a long
/// physical line do not silently concatenate beyond the per-chunk limit.
fn chunks(text: &str) -> Result<Vec<String>, &'static str> {
    if text.len() > MAX_DOC_BYTES {
        return Err("DOC_INDEX_SIZE_LIMIT");
    }
    let mut output = Vec::new();
    let mut current = Vec::new();
    let mut count = 0_usize;
    let mut fenced = false;
    for line in python_lines(text) {
        if trimmed_fence(line) {
            fenced = !fenced;
        }
        if !fenced && heading(line) && !current.is_empty() && count >= MAX_CHARS * 6 / 10 {
            flush(&mut output, &mut current, &mut count);
        }
        let chars: Vec<char> = line.chars().collect();
        if chars.len() + 1 > MAX_CHARS {
            flush(&mut output, &mut current, &mut count);
            for part in chars.chunks(MAX_CHARS) {
                let piece: String = part.iter().collect();
                if part.len() == MAX_CHARS {
                    output.push(piece);
                } else {
                    count = part.len() + 1;
                    current.push(piece);
                }
                if output.len() > MAX_CHUNKS {
                    return Err("DOC_INDEX_TOO_MANY_CHUNKS");
                }
            }
            continue;
        }
        if !current.is_empty() && count + chars.len() + 1 > MAX_CHARS {
            flush(&mut output, &mut current, &mut count);
        }
        current.push(line.to_owned());
        count += chars.len() + 1;
        if output.len() > MAX_CHUNKS {
            return Err("DOC_INDEX_TOO_MANY_CHUNKS");
        }
    }
    flush(&mut output, &mut current, &mut count);
    if output.len() > MAX_CHUNKS {
        return Err("DOC_INDEX_TOO_MANY_CHUNKS");
    }
    debug_assert!(output.iter().all(|part| part.chars().count() <= MAX_CHARS));
    Ok(output)
}

pub fn chunk_request(input: &Value) -> Value {
    let Some(text) = input.get("text").and_then(Value::as_str) else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    match chunks(text) {
        Ok(parts) => json!({"ok":true,"chunks":parts}),
        Err(code) => failure(code),
    }
}

fn first_hash_bytes(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())[..8].to_owned()
}

/// Reconstruct the exact canonical chunk write envelope, without credentials,
/// actual MemoryCore access or ledger mutation. Caller independently checks
/// every task ID, hash, marker and body before using it for a write.
pub fn write_plan(input: &Value) -> Value {
    let Some(parts) = input.get("chunks").and_then(Value::as_array) else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    if parts.len() > MAX_CHUNKS {
        return failure("DOC_INDEX_TOO_MANY_CHUNKS");
    }
    let get = |name| input.get(name).and_then(Value::as_str);
    let (
        Some(rel),
        Some(title),
        Some(root_id),
        Some(doc_id),
        Some(rev),
        Some(ts),
        Some(team),
        Some(user),
    ) = (
        get("rel"),
        get("title"),
        get("rootId"),
        get("docId"),
        get("rev"),
        get("timestamp"),
        get("team"),
        get("user"),
    )
    else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    if rel.is_empty()
        || root_id.len() != 8
        || doc_id.len() != 8
        || rev.len() != 8
        || !root_id.bytes().all(|b| b.is_ascii_hexdigit())
        || !doc_id.bytes().all(|b| b.is_ascii_hexdigit())
        || !rev.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return failure("DOC_INDEX_INVALID_INPUT");
    }
    let mut tasks = Vec::with_capacity(parts.len());
    for (i, part) in parts.iter().enumerate() {
        let Some(body) = part.as_str() else {
            return failure("DOC_INDEX_INVALID_INPUT");
        };
        if body.chars().count() > MAX_CHARS {
            return failure("DOC_INDEX_SIZE_LIMIT");
        }
        let hash = first_hash_bytes(body);
        let ordinal = i + 1;
        let task_id = format!("docs-{doc_id}-r{rev}-c{ordinal:02}");
        let marker = format!(
            "[doc-ref:{rel}#{rev} chunk {ordinal}/{} hash {hash}]",
            parts.len()
        );
        let header = format!(
            "{marker}\ntitle: {title}\nsource: {rel} (canonical file on disk — this memory record is its indexed copy)\nrevision: {rev}\nroot-id: {root_id}\nchunk: {ordinal}/{}\ncontent-hash: {hash}\nscope: {team}/{user}\ningested: {ts}\n\n",
            parts.len()
        );
        tasks.push(
            json!({"task_id":task_id,"marker":marker,"text":format!("{header}{body}"),"hash":hash}),
        );
    }
    json!({"ok":true,"tasks":tasks})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_exceeds_chunk_bound_for_long_lines() {
        let out = chunks(&"🦊".repeat(20000)).unwrap();
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|p| p.chars().count() <= MAX_CHARS));
        assert_eq!(out.join(""), "🦊".repeat(20000));
    }
    #[test]
    fn newline_rules_match_python() {
        assert_eq!(python_lines("a\r\nb\u{2028}c\n"), vec!["a", "b", "c"]);
        assert_eq!(python_lines(""), Vec::<&str>::new());
        assert_eq!(python_lines("\n"), vec![""]);
    }
    #[test]
    fn deterministic_marker_matches_canonical_text() {
        let input = json!({"chunks":["hello"],"rel":"runbook.md","title":"A","rootId":"abcdef01","docId":"12345678","rev":"01234567","timestamp":"2026-11-12T00:00:00Z","team":"docs","user":"shared"});
        let value = write_plan(&input);
        assert_eq!(value["ok"], true);
        assert_eq!(value["tasks"][0]["task_id"], "docs-12345678-r01234567-c01");
        assert_eq!(value["tasks"][0]["hash"], "2cf24dba");
    }
}

/// Select currently verifiable documentation memory rows by *index*, never
/// accepting caller-provided content as a source of authorization. The Python
/// owner parses markers and verifies the active ledger/source independently;
/// only sanitized booleans and per-request synthetic equality IDs cross the bridge.
pub fn select_retrieval(input: &Value) -> Value {
    let Some(rows) = input.get("candidates").and_then(Value::as_array) else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    if rows.len() > 512 {
        return failure("DOC_INDEX_SIZE_LIMIT");
    }
    let (Some(stale), Some(restricted), Some(limit)) = (
        input.get("includeStale").and_then(Value::as_bool),
        input.get("rootsRestricted").and_then(Value::as_bool),
        input.get("limit").and_then(Value::as_i64),
    ) else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    if !(-1_000..=512).contains(&limit) {
        return failure("DOC_INDEX_INVALID_INPUT");
    }
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::<u64>::new();
    for row in rows {
        let (
            Some(index),
            Some(valid),
            Some(superseded),
            Some(has_entry),
            Some(allowed),
            Some(current),
            Some(verified),
            Some(root),
            Some(rel),
            Some(rev),
        ) = (
            row.get("index").and_then(Value::as_u64),
            row.get("validMarker").and_then(Value::as_bool),
            row.get("superseded").and_then(Value::as_bool),
            row.get("hasEntry").and_then(Value::as_bool),
            row.get("rootAllowed").and_then(Value::as_bool),
            row.get("activeRevMatches").and_then(Value::as_bool),
            row.get("verifiedActive").and_then(Value::as_bool),
            row.get("rootId").and_then(Value::as_str),
            row.get("rel").and_then(Value::as_str),
            row.get("rev").and_then(Value::as_str),
        )
        else {
            return failure("DOC_INDEX_INVALID_INPUT");
        };
        if root.len() > 256 || rel.len() > 8192 || rev.len() > 256 {
            return failure("DOC_INDEX_SIZE_LIMIT");
        }
        if superseded || !valid {
            continue;
        }
        if restricted && (!has_entry || !allowed) {
            continue;
        }
        if !stale && (!current || !verified) {
            continue;
        }
        if !seen.insert((root.to_owned(), rel.to_owned(), rev.to_owned())) {
            continue;
        }
        selected.push(index);
        if selected.len() as i64 >= limit {
            break;
        }
    }
    json!({"ok":true,"indices":selected})
}

#[cfg(test)]
mod retrieval_tests {
    use super::*;
    #[test]
    fn only_verified_current_and_unique_rows_are_selected() {
        let row = |index, active| {
            json!({"index":index,"validMarker":true,"superseded":false,
            "hasEntry":true,"rootAllowed":true,"activeRevMatches":active,"verifiedActive":true,
            "rootId":"abcdef01","rel":"runbook.md","rev":"12345678"})
        };
        let input = json!({"candidates":[row(0,false),row(1,true),row(2,true)],
            "limit":10,"includeStale":false,"rootsRestricted":true});
        assert_eq!(select_retrieval(&input)["indices"], json!([1]));
        let mut restricted = input;
        restricted["candidates"][1]["rootAllowed"] = json!(false);
        assert_eq!(select_retrieval(&restricted)["indices"], json!([2]));
    }
}

/// Return one ledger row index using only caller-computed match booleans.
/// The host owns path comparison, root authorization, and all reads/writes.
pub fn locate_entry(input: &Value) -> Value {
    let (Some(rows), Some(pinned)) = (
        input.get("candidates").and_then(Value::as_array),
        input.get("rootPinned").and_then(Value::as_bool),
    ) else {
        return failure("DOC_INDEX_INVALID_INPUT");
    };
    let mut first = None;
    let mut ambiguous = false;
    for (index, row) in rows.iter().enumerate() {
        let (Some(matches), Some(root_matches)) = (
            row.get(0).and_then(Value::as_bool),
            row.get(1).and_then(Value::as_bool),
        ) else {
            return failure("DOC_INDEX_INVALID_INPUT");
        };
        if row.as_array().map(Vec::len) != Some(2) || (!pinned && root_matches) {
            return failure("DOC_INDEX_INVALID_INPUT");
        }
        if matches && (!pinned || root_matches) {
            if first.is_none() {
                first = Some(index);
            } else if !pinned {
                ambiguous = true;
            }
        }
    }
    json!({"ok":true,"index":if ambiguous { None } else { first }})
}

#[cfg(test)]
mod locator_tests {
    use super::*;

    #[test]
    fn location_requires_unambiguous_match_or_pin() {
        assert_eq!(
            locate_entry(&json!({"candidates":[[true,false],[true,false]],"rootPinned":false})),
            json!({"ok":true,"index":null})
        );
        assert_eq!(
            locate_entry(
                &json!({"candidates":[[true,false],[true,true],[true,true]],"rootPinned":true})
            ),
            json!({"ok":true,"index":1})
        );
        assert_eq!(
            locate_entry(&json!({"candidates":[[true,false],[false,true]],"rootPinned":true})),
            json!({"ok":true,"index":null})
        );
    }

    #[test]
    fn malformed_tail_is_rejected_even_after_a_match() {
        assert_eq!(
            locate_entry(&json!({"candidates":[[true,true],[false,1]],"rootPinned":true})),
            failure("DOC_INDEX_INVALID_INPUT")
        );
    }
}
