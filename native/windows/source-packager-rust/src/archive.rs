//! Replaces native/windows/build_source_variants.py and scan_source_archive.py.
//! SOURCE-only ZIPs are deterministic and never interpreted as installers.
use crate::classifier::{self, Partition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

const MAX_UNPACKED: u64 = 96 * 1024 * 1024;
const MAX_MEMBER: u64 = 16 * 1024 * 1024;
const SOURCE_STATUS: &str = "SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
}
#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub ok: bool,
    pub issues: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_ready: Option<bool>,
}
fn hash(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}
fn fail(message: impl Into<String>) -> String {
    message.into()
}
fn options() -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(7))
        .last_modified_time(
            DateTime::from_date_and_time(2026, 1, 1, 0, 0, 0).expect("valid ZIP timestamp"),
        )
        .unix_permissions(0o644)
}

pub fn safe_member(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 240
        || name.starts_with('/')
        || name.contains('\\')
        || !name.is_ascii()
    {
        return false;
    }
    let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    for part in name.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 200
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
        {
            return false;
        }
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if reserved.contains(&base.as_str()) {
            return false;
        }
        if base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0'
        {
            return false;
        }
    }
    true
}
fn archive_error(issues: Vec<String>) -> ScanResult {
    let mut issues = issues;
    issues.sort();
    issues.dedup();
    ScanResult {
        ok: false,
        issues,
        variant: None,
        count: None,
        release_ready: None,
    }
}
fn zip_bytes<R: Read>(reader: R, limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("ZIP member read failed: {e}"))?;
    if out.len() as u64 > limit {
        return Err("ZIP member exceeded size limit".into());
    }
    Ok(out)
}

/// Reads each entry completely (CRC checked by the ZIP decoder). Never extracts.
/// Encrypted / incompatible compression archives are rejected through decoder errors.
pub fn scan(path: &Path) -> ScanResult {
    match scan_checked(path) {
        Ok(r) => r,
        Err(s) => archive_error(vec![s]),
    }
}
fn scan_checked(path: &Path) -> Result<ScanResult, String> {
    let file = File::open(path).map_err(|e| format!("cannot open ZIP: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("invalid ZIP: {e}"))?;
    let count = zip.len();
    let mut issues = Vec::<String>::new();
    let mut names = HashSet::<String>::new();
    let mut casefold = HashSet::<String>::new();
    let mut data = BTreeMap::<String, Vec<u8>>::new();
    let mut unpacked = 0_u64;
    for i in 0..count {
        let mut member = zip
            .by_index(i)
            .map_err(|e| format!("unreadable or encrypted ZIP entry: {e}"))?;
        let name = member.name().to_string();
        if !safe_member(&name) || member.is_dir() {
            issues
                .push("invalid Windows member, reserved name or case-insensitive collision".into());
        }
        if !names.insert(name.clone()) || !casefold.insert(name.to_ascii_lowercase()) {
            issues.push("invalid or duplicate archive member".into());
        }
        let parts: Vec<_> = name.split('/').collect();
        if parts.iter().any(|p| {
            [
                "node_modules",
                "__pycache__",
                ".git",
                "secrets",
                ".venv",
                "runs",
            ]
            .contains(&p.to_ascii_lowercase().as_str())
        }) {
            issues.push("forbidden runtime directory".into());
        }
        if [
            ".db", ".sqlite", ".sqlite3", ".key", ".pem", ".pfx", ".p12", ".log", ".kdbx",
        ]
        .iter()
        .any(|s| name.to_ascii_lowercase().ends_with(s))
        {
            issues.push("forbidden private/runtime file type".into());
        }
        unpacked = unpacked.saturating_add(member.size());
        if unpacked > MAX_UNPACKED {
            issues.push("uncompressed source budget exceeded".into());
        }
        if member.size() > MAX_MEMBER {
            issues.push("oversized source file".into());
        }
        if !matches!(
            member.compression(),
            CompressionMethod::Deflated | CompressionMethod::Stored
        ) {
            issues.push("unsupported archive compression".into());
        }
        if member
            .unix_mode()
            .map(|x| x & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            issues.push("symbolic link in source archive".into());
        }
        // Enforce budget BEFORE decompression; data read is capped even for invalid archives.
        let bytes =
            zip_bytes(&mut member, MAX_MEMBER).map_err(|e| format!("ZIP member {name}: {e}"))?;
        data.insert(name, bytes);
    }
    if !names.contains("NATIVE_WINDOWS_SOURCE_MANIFEST.json") || !names.contains("SHA256SUMS") {
        issues.push("missing manifest/checksums".into());
        return Ok(ScanResult {
            ok: false,
            issues,
            variant: None,
            count: None,
            release_ready: None,
        });
    }
    let manifest: Value = serde_json::from_slice(&data["NATIVE_WINDOWS_SOURCE_MANIFEST.json"])
        .map_err(|e| format!("invalid source manifest JSON: {e}"))?;
    let variant = manifest["variant"]
        .as_u64()
        .and_then(|n| u8::try_from(n).ok());
    if !matches!(variant, Some(2)) || manifest["release_status"] != SOURCE_STATUS {
        issues.push("invalid source-only profile".into());
    }
    if manifest["repoql"]["requiredVersion"] != "1.7.18" {
        issues.push("RepoQL 1.7.18 pin missing".into());
    }
    if manifest["repoql"]["connectorContract"] != "fetch-render"
        || manifest["repoql"].get("connectorAbi").is_some()
    {
        issues.push("current fetch/render connector contract missing".into());
    }
    let office = true;
    if [
        "office",
        "repoql_dashboard",
        "tencent_connector",
        "kanzo",
        "openmausbot",
        "memory",
        "repoql_mcp",
    ]
    .iter()
    .any(|key| manifest["features"][*key] != Value::Bool(true))
        || manifest["rustOfficeFeature"] != Value::Bool(office)
        || manifest["features"]["ghost"] != Value::Bool(false)
        || manifest["rustGhostFeature"] != Value::Bool(false)
    {
        issues.push("full Claude Code feature contract missing".into());
    }
    if manifest["no_wsl_required_for_intended_runtime"] == Value::Bool(true) {
        issues.push("unsupported native Windows acceptance claim".into());
    }
    if manifest["production_feature_parity"] != "UNVERIFIED" {
        issues.push("unsupported production parity assertion".into());
    }
    let payload: HashSet<String> = names
        .iter()
        .filter(|n| n.as_str() != "NATIVE_WINDOWS_SOURCE_MANIFEST.json")
        .cloned()
        .collect();
    if payload
        .iter()
        .any(|n| classifier::windows_retired_source(n))
    {
        issues.push("Retired component entered Windows source package".into());
    }
    if payload
        .iter()
        .any(|n| classifier::linux_deployment_asset(n))
    {
        issues.push("Linux/Docker deployment entrypoint in Windows source package".into());
    }
    if let Some(receipts) = manifest["files"].as_array() {
        let receipt_names: Vec<_> = receipts
            .iter()
            .filter_map(|r| r["path"].as_str().map(str::to_string))
            .collect();
        if receipt_names.iter().cloned().collect::<HashSet<_>>() != payload
            || receipt_names.len() != payload.len()
        {
            issues.push("file manifest does not match the ZIP".into());
        } else {
            for row in receipts {
                let Some(name) = row["path"].as_str() else {
                    issues.push("file manifest does not match the ZIP".into());
                    break;
                };
                let Some(bytes) = data.get(name) else {
                    issues.push("file manifest does not match the ZIP".into());
                    break;
                };
                if row["sha256"] != hash(bytes) || row["bytes"].as_u64() != Some(bytes.len() as u64)
                {
                    issues.push("manifest SHA256 or size mismatch".into());
                    break;
                }
            }
        }
    } else {
        issues.push("file manifest does not match the ZIP".into());
    }
    let sha_text = std::str::from_utf8(&data["SHA256SUMS"])
        .map_err(|e| format!("invalid SHA256SUMS UTF-8: {e}"))?;
    let mut hashes = BTreeMap::<String, String>::new();
    let mut malformed = false;
    for line in sha_text.lines() {
        let Some((digest, name)) = line.split_once("  ") else {
            malformed = true;
            break;
        };
        if hashes
            .insert(name.to_string(), digest.to_string())
            .is_some()
        {
            malformed = true;
            break;
        }
    }
    let expected: HashSet<String> = payload
        .iter()
        .filter(|n| n.as_str() != "SHA256SUMS")
        .cloned()
        .collect();
    if malformed || hashes.keys().cloned().collect::<HashSet<_>>() != expected {
        issues.push("SHA256SUMS inventory mismatch".into());
    } else if hashes
        .iter()
        .any(|(name, digest)| data.get(name).is_none_or(|b| hash(b) != *digest))
    {
        issues.push("SHA256SUMS digest mismatch".into());
    }
    if [
        "native/windows/openmausbot/",
        "connectors/kanzo/",
        "connectors/memorycore/",
        "dashboard/",
        "office/",
        "adapters/claude-code/",
    ]
    .iter()
    .any(|prefix| !names.iter().any(|name| name.starts_with(*prefix)))
    {
        issues.push("full Claude Code component source missing".into());
    }
    if names.iter().any(|n| {
        [".exe", ".dll", ".msi", ".msix"]
            .iter()
            .any(|ext| n.to_ascii_lowercase().ends_with(ext))
    }) {
        issues.push("binary executable in source-only package".into());
    }
    issues.sort();
    issues.dedup();
    Ok(ScanResult {
        ok: issues.is_empty(),
        issues,
        variant,
        count: Some(count),
        release_ready: Some(false),
    })
}

#[derive(Debug, Serialize)]
pub struct BuildOutput {
    pub variant: u8,
    pub name: String,
    pub bytes: u64,
    pub file_count: usize,
    pub sha256: String,
}
/// Full Rust port of the canonical source builder: no Python or Node processes.
pub fn build(root: &Path, variant: u8, output: &Path) -> Result<BuildOutput, String> {
    if variant != 2 {
        return Err(fail("only Claude Code Full is supported"));
    }
    let policy: Value = serde_json::from_slice(
        &fs::read(root.join("native/windows/variants.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("invalid variants.json: {e}"))?;
    let key = variant.to_string();
    let spec = &policy["variants"][key.as_str()];
    let office = true;
    if [
        "office",
        "repoql_dashboard",
        "tencent_connector",
        "kanzo",
        "openmausbot",
        "memory",
        "repoql_mcp",
    ]
    .iter()
    .any(|key| spec["features"][*key] != true)
        || spec["features"]["ghost"] != false
    {
        return Err("full Claude Code feature policy incomplete".into());
    }
    let shipped = classifier::walk_shipped_files(root)?;
    let selected = Partition::for_files(&shipped).selected_for_windows(variant)?;
    for name in &selected {
        if !safe_member(name) {
            return Err(format!("unsafe Windows path: {name}"));
        }
        if classifier::windows_retired_source(name) {
            return Err(format!("Retired source leaked: {name}"));
        }
    }
    for prefix in [
        "native/windows/openmausbot/",
        "connectors/kanzo/",
        "connectors/memorycore/",
        "dashboard/",
        "office/",
        "adapters/claude-code/",
    ] {
        if !selected.iter().any(|name| name.starts_with(prefix)) {
            return Err(format!(
                "full Claude Code component source missing: {prefix}"
            ));
        }
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Failure leaves no partially-valid output at the requested destination.
    let staged = output.with_extension("zip.incomplete");
    let _ = fs::remove_file(&staged);
    let result = (|| -> Result<(Vec<Receipt>, usize), String> {
        let out = File::create(&staged).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(out);
        let mut receipts = Vec::new();
        let mut total = 0_u64;
        for name in &selected {
            let path = root.join(name);
            let md = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !md.file_type().is_file() {
                return Err(format!("source symlink or non-file refused: {name}"));
            }
            let bytes = fs::read(&path).map_err(|e| format!("cannot read {name}: {e}"))?;
            total = total.saturating_add(bytes.len() as u64);
            if bytes.len() as u64 > MAX_MEMBER || total > MAX_UNPACKED {
                return Err("source archive byte budget exceeded".into());
            }
            zip.start_file(name.as_str(), options())
                .map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            receipts.push(Receipt {
                path: name.clone(),
                sha256: hash(&bytes),
                bytes: bytes.len(),
            });
        }
        let checksums = receipts
            .iter()
            .map(|r| format!("{}  {}\n", r.sha256, r.path))
            .collect::<String>();
        zip.start_file("SHA256SUMS", options())
            .map_err(|e| e.to_string())?;
        zip.write_all(checksums.as_bytes())
            .map_err(|e| e.to_string())?;
        receipts.push(Receipt {
            path: "SHA256SUMS".into(),
            sha256: hash(checksums.as_bytes()),
            bytes: checksums.len(),
        });
        let manifest = json!({
            "schema":1,
            "product":"Singularity RepoQL native Windows SOURCE review",
            "variant":variant,"gui":spec["gui"],"features":spec["features"],
            "rustOfficeFeature":office,
            "rustGhostFeature":false,
            "repoql":policy["repoql"],"release_status":SOURCE_STATUS,
            "no_wsl_required_for_intended_runtime":"UNVERIFIED_NATIVE_ACCEPTANCE_REQUIRED",
            "production_feature_parity":"UNVERIFIED",
            "linux_deployment_assets_excluded":true,
            "acceptance":"NOT_RUN_ON_NATIVE_WINDOWS",
            "files":receipts,
        });
        let mut json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        json.push('\n');
        zip.start_file("NATIVE_WINDOWS_SOURCE_MANIFEST.json", options())
            .map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
        Ok((receipts, selected.len()))
    })();
    let (_, file_count) = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
    };
    let scan_result = scan(&staged);
    if !scan_result.ok {
        let _ = fs::remove_file(&staged);
        return Err(format!(
            "release scanner rejected source: {}",
            scan_result.issues.join("; ")
        ));
    }
    // Do not silently clobber a release artifact from a separate source revision.
    if output.exists() {
        let _ = fs::remove_file(&staged);
        return Err(format!(
            "output exists, refusing overwrite: {}",
            output.display()
        ));
    }
    fs::rename(&staged, output).map_err(|e| format!("cannot publish validated ZIP: {e}"))?;
    let bytes = fs::read(output).map_err(|e| e.to_string())?;
    Ok(BuildOutput {
        variant,
        name: output
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        bytes: bytes.len() as u64,
        file_count,
        sha256: hash(&bytes),
    })
}
pub fn build_all(root: &Path, output_dir: &Path, only: Option<u8>) -> Result<Value, String> {
    let targets: Vec<u8> = only.map_or_else(|| vec![2], |v| vec![v]);
    let mut outputs = Vec::new();
    for v in targets {
        let name = format!("singularity-native-windows-option{v}-SOURCE-ONLY.zip");
        outputs.push(build(root, v, &output_dir.join(name))?);
    }
    Ok(json!({"release_status":"NOT_READY","outputs":outputs}))
}

pub fn scan_many(paths: &[PathBuf]) -> (Value, bool) {
    let results = paths
        .iter()
        .map(|p| (p.display().to_string(), scan(p)))
        .collect::<BTreeMap<_, _>>();
    let ok = results.values().all(|x| x.ok);
    (serde_json::to_value(results).unwrap_or(Value::Null), ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_ntfs_edge_cases() {
        for n in [
            "C:/a",
            "a/../b",
            "a//b",
            "CON.txt",
            "NUL",
            "LPT1.md",
            "name.",
            "bad|name.txt",
            "a\\b",
            "foo/",
            "föo.txt",
        ] {
            assert!(!safe_member(n), "{n}");
        }
        for n in [
            "src/a.rs",
            "native/windows/source-packager-rust/Cargo.toml",
            "AGENTS.md",
        ] {
            assert!(safe_member(n), "{n}");
        }
    }
    #[test]
    fn scanner_rejects_untrusted_zip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("untrusted.zip");
        let mut z = ZipWriter::new(File::create(&path).unwrap());
        z.start_file("a/../b.txt", options()).unwrap();
        z.write_all(b"bad").unwrap();
        z.finish().unwrap();
        assert!(!scan(&path).ok);
    }
}
