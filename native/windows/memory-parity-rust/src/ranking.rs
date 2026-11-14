//! Port of liveSourceOrder from harness/kit/lib/repoql-client.mjs.
//! No dropping, no score rewriting, canonical sibling identity includes the extension.
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

fn basename(uri: &str) -> &str {
    uri.rsplit('/').next().unwrap_or("")
}

fn artifact_cut(filename: &str) -> Option<usize> {
    if filename.ends_with('~') {
        return Some(filename.len() - 1);
    }
    let lower = filename.to_ascii_lowercase();
    for (pos, _) in lower.match_indices('.') {
        let suffix = &lower[pos + 1..];
        if [
            "bak",
            "orig",
            "old",
            "candidate",
            "before-",
            "dup-removed-",
            "pre-",
        ]
        .iter()
        .any(|prefix| suffix.starts_with(prefix))
        {
            return Some(pos);
        }
    }
    None
}

fn canonical_name(uri: &str) -> String {
    let name = basename(uri);
    name[..artifact_cut(name).unwrap_or(name.len())].to_ascii_lowercase()
}

fn sibling_key(uri: &str) -> String {
    let dir = uri.rsplit_once('/').map(|(d, _)| d).unwrap_or(uri);
    format!("{dir}\0{}", canonical_name(uri))
}

fn rank(row: &Value, canonical: &HashSet<String>, query: &str) -> (bool, u8, f64) {
    let uri = row.get("uri").and_then(Value::as_str).unwrap_or("");
    let name = canonical_name(uri);
    let stem = name
        .rsplit_once('.')
        .filter(|(_, ext)| !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|(a, _)| a)
        .unwrap_or(&name);
    let is_demoted = artifact_cut(basename(uri)).is_some() && canonical.contains(&sibling_key(uri));
    let q = query
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<String>();
    let exact = if name.len() >= 4 && q.contains(&name) {
        2
    } else if stem.len() >= 4 && q.contains(stem) {
        1
    } else {
        0
    };
    let score = row
        .get("score")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NEG_INFINITY);
    (is_demoted, exact, score)
}

pub fn live_source_order(mut rows: Vec<Value>, query: &str) -> Vec<Value> {
    let canonical: HashSet<String> = rows
        .iter()
        .filter_map(|r| {
            let uri = r.get("uri").and_then(Value::as_str)?;
            if artifact_cut(basename(uri)).is_none() {
                Some(sibling_key(uri))
            } else {
                None
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        let ka = rank(a, &canonical, query);
        let kb = rank(b, &canonical, query);
        ka.0.cmp(&kb.0)
            .then_with(|| kb.1.cmp(&ka.1))
            .then_with(|| kb.2.partial_cmp(&ka.2).unwrap_or(Ordering::Equal))
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_same_directory_same_filename_backups_are_demoted() {
        let rows = vec![
            json!({"uri":"local:///src/config.mjs.bak","score":0.9}),
            json!({"uri":"local:///src/config.mjs","score":0.5}),
            json!({"uri":"local:///other/config.mjs.bak","score":0.95}),
        ];
        let ordered = live_source_order(rows, "config");
        let uris: Vec<&str> = ordered.iter().map(|r| r["uri"].as_str().unwrap()).collect();
        assert_eq!(
            uris,
            [
                "local:///other/config.mjs.bak",
                "local:///src/config.mjs",
                "local:///src/config.mjs.bak"
            ]
        );
    }
    #[test]
    fn exact_extension_beats_stem() {
        let rows = vec![
            json!({"uri":"local:///p/config.js","score":0.9}),
            json!({"uri":"local:///p/config.mjs","score":0.5}),
        ];
        assert_eq!(
            live_source_order(rows, "src/config.mjs")[0]["uri"],
            "local:///p/config.mjs"
        );
    }
    #[test]
    fn preserves_rows_and_scores() {
        let rows = vec![
            json!({"uri":"x/a.mjs","score":0.1}),
            json!({"uri":"x/b.mjs","score":0.9}),
        ];
        let output = live_source_order(rows.clone(), "anything");
        assert_eq!(output.len(), 2);
        for r in rows {
            assert!(output.contains(&r));
        }
    }
}
