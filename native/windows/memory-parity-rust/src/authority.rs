//! Port of native/windows/memory_authority_preflight.py.
//! A read-only directory readiness diagnostic, never a deployment gate.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub fn inspect(root: &Path, env: &HashMap<String, String>) -> Value {
    let config = root.join("harness").join("kit").join("config.json");
    let doc: Value = match fs::read_to_string(&config)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return json!({"ok":false,"code":"KIT_CONFIG_UNAVAILABLE","checks":{}}),
    };
    let default_filter = doc
        .get("memoryProvenance")
        .and_then(|v| v.get("retrievalFilter"))
        .and_then(Value::as_str)
        .unwrap_or("DISABLED");
    let requested = env
        .get("ORCH_MEMORY_RETRIEVAL_FILTER")
        .map(String::as_str)
        .unwrap_or(default_filter);
    let enabled = requested.to_uppercase() == "ENABLED";
    let mut checks = serde_json::Map::new();
    let mut all_ready = true;
    for (name, key) in [
        ("tombstones", "ORCH_TOMBSTONES_DIR"),
        ("lineage", "ORCH_LINEAGE_DIR"),
    ] {
        let raw = env.get(key).map(String::as_str).unwrap_or("");
        let path = Path::new(raw);
        let is_dir = !raw.is_empty() && path.is_dir();
        let not_symlink = is_dir
            && fs::symlink_metadata(path)
                .map(|m| !m.file_type().is_symlink())
                .unwrap_or(false);
        all_ready &= !raw.is_empty() && is_dir && not_symlink;
        checks.insert(
            name.to_owned(),
            json!({
                "configured": !raw.is_empty(),
                "localDirectoryExists": is_dir,
                "notSymlink": not_symlink,
            }),
        );
    }
    let ok = !enabled || all_ready;
    json!({
        "ok": ok,
        "code": if ok { "WINDOWS_MEMORY_AUTHORITY_READY_FOR_RUNTIME_TEST" } else { "WINDOWS_MEMORY_AUTHORITY_UNVERIFIED" },
        "retrievalFilterEnabled": enabled,
        "checks": checks,
        "note": "Directory readiness only; does not verify native Windows live MemoryCore or RepoQL",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn directory_readiness_and_disabled_mode() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("singularity-preflight-{}-{n}", std::process::id()));
        let config = root.join("harness/kit/config.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(
            &config,
            r#"{"memoryProvenance":{"retrievalFilter":"ENABLED"}}"#,
        )
        .unwrap();
        let mut env = HashMap::new();
        assert_eq!(inspect(&root, &env)["ok"], false);
        env.insert(
            "ORCH_MEMORY_RETRIEVAL_FILTER".to_owned(),
            "DISABLED".to_owned(),
        );
        assert_eq!(inspect(&root, &env)["ok"], true);
        env.remove("ORCH_MEMORY_RETRIEVAL_FILTER");
        for (name, key) in [
            ("tombstones", "ORCH_TOMBSTONES_DIR"),
            ("lineage", "ORCH_LINEAGE_DIR"),
        ] {
            let p = root.join(name);
            fs::create_dir(&p).unwrap();
            env.insert(key.to_owned(), p.to_string_lossy().into_owned());
        }
        assert_eq!(inspect(&root, &env)["ok"], true);
        fs::remove_dir_all(root).unwrap();
    }
}
