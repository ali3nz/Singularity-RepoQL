//! Read-only port of check_rust_lock_provenance.py.
//! Structure review, NOT a registry signature check or native build receipt.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

// Mirror the canonical native/windows/check_rust_lock_provenance.py list.
// Missing new-crate locks must block release even if historical crates are pinned.
const CRATES: &[(&str, &str)] = &[
    ("harness/rust-authority", "orchestra-observer"),
    ("native/desktop-bridge", "singularity-desktop-bridge"),
    (
        "native/windows/rust-supervisor",
        "singularity-windows-supervisor",
    ),
    (
        "native/windows/unified-gateway-rust",
        "unified-repoql-control",
    ),
    (
        "native/windows/memory-parity-rust",
        "singularity-memory-parity",
    ),
    ("native/windows/rc-stack-rust", "singularity-rc-stack"),
    (
        "native/windows/source-packager-rust",
        "singularity-source-packager",
    ),
    (
        "native/windows/release-evidence-rust",
        "singularity-release-evidence",
    ),
];

fn owned_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}
fn sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}
fn registry_checksum(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn inspect(root: &Path) -> Value {
    let mut rows = Vec::<Value>::new();
    for (relative, name) in CRATES {
        let cargo = root.join(relative).join("Cargo.toml");
        let lock = root.join(relative).join("Cargo.lock");
        let manifest_present = cargo.is_file();
        let lockfile_present = lock.is_file();
        let mut row = json!({"crate":relative,"manifestPresent":manifest_present,
            "lockfilePresent":lockfile_present,"lockfileValid":false});
        if !manifest_present
            || !lockfile_present
            || !owned_regular_file(&cargo)
            || !owned_regular_file(&lock)
        {
            rows.push(row);
            continue;
        }
        let Ok(manifest_bytes) = fs::read(&cargo) else {
            rows.push(row);
            continue;
        };
        let Ok(lock_bytes) = fs::read(&lock) else {
            rows.push(row);
            continue;
        };
        let Ok(manifest_text) = std::str::from_utf8(&manifest_bytes) else {
            rows.push(row);
            continue;
        };
        let Ok(lock_text) = std::str::from_utf8(&lock_bytes) else {
            rows.push(row);
            continue;
        };
        let Ok(manifest) = manifest_text.parse::<toml::Value>() else {
            rows.push(row);
            continue;
        };
        let Ok(obj) = lock_text.parse::<toml::Value>() else {
            rows.push(row);
            continue;
        };
        let packages = obj.get("package").and_then(toml::Value::as_array);
        let package_name = manifest
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(toml::Value::as_str);
        let package_version = manifest
            .get("package")
            .and_then(|p| p.get("version"))
            .and_then(toml::Value::as_str);
        let lock_version = obj.get("version").and_then(toml::Value::as_integer);
        let Some(packages) = packages else {
            rows.push(row);
            continue;
        };
        if package_name != Some(*name)
            || !matches!(lock_version, Some(3 | 4))
            || packages.is_empty()
        {
            rows.push(row);
            continue;
        }
        let roots = packages
            .iter()
            .filter(|p| {
                p.get("name").and_then(toml::Value::as_str) == Some(*name)
                    && p.get("version").and_then(toml::Value::as_str) == package_version
            })
            .count();
        let mut valid = roots == 1;
        let mut identities = HashSet::new();
        let mut registry_count = 0usize;
        for p in packages {
            let Some(p) = p.as_table() else {
                valid = false;
                break;
            };
            let name = p.get("name").and_then(toml::Value::as_str).unwrap_or("");
            let version = p.get("version").and_then(toml::Value::as_str).unwrap_or("");
            let source = p.get("source").and_then(toml::Value::as_str).unwrap_or("");
            if name.is_empty() || version.is_empty() || !identities.insert((name, version, source))
            {
                valid = false;
                break;
            }
            if p.contains_key("source") {
                let checksum = p
                    .get("checksum")
                    .and_then(toml::Value::as_str)
                    .unwrap_or("");
                if !source.starts_with("registry+") || !registry_checksum(checksum) {
                    valid = false;
                    break;
                }
                registry_count += 1;
            }
        }
        if registry_count == 0 {
            valid = false;
        }
        row["lockfileValid"] = json!(valid);
        row["resolvedPackages"] = json!(packages.len());
        row["registryPackagesWithChecksums"] = json!(registry_count);
        row["sha256"] = json!(sha256(&lock_bytes));
        rows.push(row);
    }
    let ready = rows.iter().all(|r| r["lockfileValid"] == true);
    json!({"schema":"singularity-rust-lock-release-gate/v1","checks":rows,
        "readyForRustDependencyReview":ready,"nativeWindowsBuildVerified":false,
        "publisherProvenanceVerified":false,"releaseReady":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn no_locks_fail_closed_and_well_formed_structure_passes() {
        let dir = tempdir().unwrap();
        assert_eq!(inspect(dir.path())["readyForRustDependencyReview"], false);
        for (rel, name) in CRATES {
            let location = dir.path().join(rel);
            fs::create_dir_all(&location).unwrap();
            fs::write(
                location.join("Cargo.toml"),
                format!("[package]\nname=\"{name}\"\nversion=\"0.1.0\"\n"),
            )
            .unwrap();
            fs::write(location.join("Cargo.lock"),format!("version = 4\n[[package]]\nname=\"{name}\"\nversion=\"0.1.0\"\n[[package]]\nname=\"dependency\"\nversion=\"1.0.0\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum=\"{}\"\n", "a".repeat(64))).unwrap();
        }
        assert_eq!(inspect(dir.path())["readyForRustDependencyReview"], true);
        assert_eq!(inspect(dir.path())["releaseReady"], false);
    }
    #[test]
    fn registry_checksum_is_lowercase_hex() {
        assert!(registry_checksum(&"a".repeat(64)));
        assert!(!registry_checksum(&"G".repeat(64)));
        assert!(!registry_checksum(&"A".repeat(64)));
    }
}
