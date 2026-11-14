//! Byte-accurate, read-only payload budget policy from payload-budget.mjs.
//! SHA256 values identify included serialized UTF-8 text. No input is truncated
//! or silently admitted when a cap is exceeded.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ATTACH_TOTAL_BYTES: usize = 24_000;
pub const ATTACH_PER_FILE_BYTES: usize = 8_000;

pub fn sha256_of_text(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    format!("{digest:x}")
}

pub fn budget(input: &Value) -> Value {
    let total_cap = input
        .get("totalCap")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(ATTACH_TOTAL_BYTES);
    let per_file_cap = input
        .get("perFileCap")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(ATTACH_PER_FILE_BYTES);
    let files = input.get("files").and_then(Value::as_array);
    let mut included = Vec::new();
    let mut omitted = Vec::new();
    let mut reasons = Vec::new();
    let mut spent = 0usize;
    for file in files.into_iter().flatten() {
        let name = file.get("name").cloned().unwrap_or(Value::Null);
        let content = file.get("content").and_then(Value::as_str).unwrap_or("");
        let bytes = content.len(); // UTF-8 bytes, not Unicode scalar count
        if bytes > per_file_cap {
            omitted.push(json!({"name":name.clone(),"bytes":bytes,"reason":format!("per-file cap {per_file_cap} exceeded")}));
            reasons.push(format!(
                "{}: {bytes}B > per-file cap {per_file_cap}B",
                name.as_str().unwrap_or("null")
            ));
            continue;
        }
        if bytes > total_cap.saturating_sub(spent) {
            omitted.push(json!({"name":name.clone(),"bytes":bytes,"reason":format!("total cap {total_cap} would be exceeded")}));
            reasons.push(format!(
                "{}: would exceed total cap {total_cap}B",
                name.as_str().unwrap_or("null")
            ));
            continue;
        }
        spent += bytes;
        included.push(json!({"name":name.clone(),"bytes":bytes,"sha256":sha256_of_text(content)}));
    }
    json!({"ok":omitted.is_empty(),"totalBytes":spent,"included":included,"omitted":omitted,"reasons":reasons})
}

/// Split while preserving exact UTF-8 input, line delimiters and character
/// boundaries. Identical to the source's byte-part contract for a positive cap.
pub fn split_into_byte_parts(text: &str, cap: usize) -> Result<Vec<String>, &'static str> {
    if cap == 0 {
        return Err("cap must be positive");
    }
    if text.is_empty() {
        return Ok(vec![]);
    }
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    // split_inclusive keeps a trailing newline attached to the preceding line.
    for line in text.split_inclusive('\n') {
        if line.len() > cap {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            let mut start = 0;
            while start < line.len() {
                let mut end = std::cmp::min(start + cap, line.len());
                while end > start && !line.is_char_boundary(end) {
                    end -= 1;
                }
                if end == start {
                    // A single UTF-8 scalar cannot fit in a smaller cap.
                    return Err("cap is too small for a UTF-8 code point");
                }
                parts.push(line[start..end].to_owned());
                start = end;
            }
        } else {
            if !current.is_empty() && current.len() + line.len() > cap {
                parts.push(std::mem::take(&mut current));
            }
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omission_is_reported_not_truncated() {
        let v = budget(
            &json!({"files":[{"name":"a","content":"é"},{"name":"b","content":"abc"}],"perFileCap":2,"totalCap":3}),
        );
        assert_eq!(v["totalBytes"], json!(2));
        assert_eq!(v["omitted"][0]["name"], "b");
        assert_eq!(v["included"][0]["bytes"], 2);
    }
    #[test]
    fn split_preserves_multibyte_and_newline() {
        for source in ["hello\nthere", "hi\n", "🌺🌺\ntext", "éééé", "foo\n\nbar"] {
            let parts = split_into_byte_parts(source, 5).unwrap();
            assert!(parts.iter().all(|s| s.len() <= 5));
            assert_eq!(parts.concat(), source);
        }
    }
    #[test]
    fn zero_cap_fails_safely() {
        assert!(split_into_byte_parts("abc", 0).is_err());
        assert!(split_into_byte_parts("🌺", 2).is_err());
    }
}
