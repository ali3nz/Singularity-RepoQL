//! Payload budgets: port of kit/lib/payload-budget.mjs pure helpers.
//! Transport-normalized content must be supplied by the caller.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub fn budget(files: &Value, opts: &Value) -> Value {
    let total_cap = opts
        .get("totalCap")
        .and_then(Value::as_u64)
        .unwrap_or(24_000);
    let per_file_cap = opts
        .get("perFileCap")
        .and_then(Value::as_u64)
        .unwrap_or(8_000);
    let mut included = Vec::new();
    let mut omitted = Vec::new();
    let mut reasons = Vec::new();
    let mut spent = 0u64;
    if let Some(files) = files.as_array() {
        for f in files {
            let content = f.get("content").and_then(Value::as_str).unwrap_or("");
            let name = f.get("name").cloned().unwrap_or(Value::Null);
            let count = content.len() as u64; // Rust UTF-8 strings are byte-accurate by definition.
            let label = name.as_str().unwrap_or("undefined");
            if count > per_file_cap {
                omitted.push(json!({"name":name,"bytes":count,"reason":format!("per-file cap {per_file_cap} exceeded")}));
                reasons.push(format!("{label}: {count}B > per-file cap {per_file_cap}B"));
                continue;
            }
            if spent.saturating_add(count) > total_cap {
                omitted.push(json!({"name":name,"bytes":count,"reason":format!("total cap {total_cap} would be exceeded")}));
                reasons.push(format!("{label}: would exceed total cap {total_cap}B"));
                continue;
            }
            spent += count;
            included.push(json!({"name":name,"bytes":count,"sha256":hash(content)}));
        }
    }
    json!({"ok":omitted.is_empty(),"totalBytes":spent,"included":included,"omitted":omitted,"reasons":reasons})
}

pub fn split(text: &str, cap: usize) -> Result<Vec<String>, String> {
    if cap < 4 {
        return Err("cap must be at least 4 bytes to accommodate all Unicode scalar values".into());
    }
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let lines: Vec<&str> = text.split_terminator('\n').collect();
    let trailing = text.ends_with('\n');
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, line) in lines.iter().enumerate() {
        let mut one = line.to_string();
        if trailing || i + 1 < lines.len() {
            one.push('\n');
        }
        if one.len() > cap {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            let mut piece = String::new();
            for ch in one.chars() {
                if piece.len() + ch.len_utf8() > cap {
                    out.push(std::mem::take(&mut piece));
                }
                piece.push(ch);
            }
            if !piece.is_empty() {
                out.push(piece);
            }
            continue;
        }
        if !cur.is_empty() && cur.len() + one.len() > cap {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(&one);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

pub fn sha256_of(text: &str) -> String {
    hash(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_splitting_is_exact() {
        let t = "hello🦀world\nnext\n";
        let chunks = split(t, 5).unwrap();
        assert_eq!(chunks.concat(), t);
        assert!(chunks.iter().all(|c| c.len() <= 5));
    }
    #[test]
    fn honest_manifest() {
        let x = budget(
            &json!([{"name":"one","content":"ok"},{"name":"two","content":"abcdef"}]),
            &json!({"perFileCap":4}),
        );
        assert_eq!(x["ok"], false);
        assert_eq!(x["included"].as_array().unwrap().len(), 1);
        assert_eq!(
            sha256_of("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
