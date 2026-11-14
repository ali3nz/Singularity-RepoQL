//! Read-only integrity check for a previously extracted Windows source bundle.
//!
//! This is a second source integrity gate, NOT proof of installer ownership,
//! publisher signing, service readiness, or an accepted native release.
use crate::archive::safe_member;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use walkdir::WalkDir;

const MANIFEST: &str = "NATIVE_WINDOWS_SOURCE_MANIFEST.json";
const SUMS: &str = "SHA256SUMS";
const MAX_MEMBER: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 96 * 1024 * 1024;
const MAX_MANIFEST: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 5_000;
const SNAPSHOT: &str = "STAGING_RECEIPT.json";
const BRIDGE: &str = "bin/singularity-desktop-bridge.exe";
const SUPERVISOR: &str = "bin/singularity-windows-supervisor.exe";
const OPTIONAL: &[&str] = &[
    "bin/singularity-windows-supervisorw.exe",
    "bin/unified-repoql-control.exe",
    "bin/singularity-dashboard-routes.exe",
    "bin/singularity-dashboard-listener.exe",
    "bin/singularity-doc-ledger-commit.exe",
    "bin/singularity-memorycore-writer.exe",
    "bin/singularity-windows-setup.exe",
    "bin/singularity-source-packager.exe",
    "bin/singularity-unified-proxy.exe",
];

fn plain(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !meta.file_type().is_symlink()
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "MISSING_OR_UNREADABLE_FILE")?;
    if !plain(&metadata) || !metadata.is_file() || metadata.len() > limit {
        return Err("UNSAFE_OR_OVERSIZED_FILE");
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "MISSING_OR_UNREADABLE_FILE")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "MISSING_OR_UNREADABLE_FILE")?;
    if bytes.len() as u64 > limit {
        return Err("UNSAFE_OR_OVERSIZED_FILE");
    }
    Ok(bytes)
}

fn check(root: &Path) -> Result<(u8, usize), &'static str> {
    let root_meta = fs::symlink_metadata(root).map_err(|_| "SOURCE_ROOT_UNREADABLE")?;
    if !plain(&root_meta) || !root_meta.is_dir() {
        return Err("SOURCE_ROOT_UNSAFE");
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| "SOURCE_ROOT_UNREADABLE")?;
    let raw = bounded_read(&root.join(MANIFEST), MAX_MANIFEST)?;
    let manifest: Value = serde_json::from_slice(&raw).map_err(|_| "INVALID_MANIFEST_JSON")?;
    let variant = manifest
        .get("variant")
        .and_then(Value::as_u64)
        .and_then(|x| u8::try_from(x).ok())
        .ok_or("INVALID_VARIANT")?;
    if variant != 2 || manifest["schema"] != 1 {
        return Err("INVALID_VARIANT");
    }
    if manifest["release_status"] != "SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER"
        || manifest["production_feature_parity"] != "UNVERIFIED"
        || manifest["acceptance"] != "NOT_RUN_ON_NATIVE_WINDOWS"
    {
        return Err("FALSE_RELEASE_ACCEPTANCE_CLAIM");
    }
    if manifest["no_wsl_required_for_intended_runtime"] == true {
        return Err("FALSE_NATIVE_RUNTIME_CLAIM");
    }
    if manifest["repoql"]["requiredVersion"] != "1.7.18"
        || manifest["repoql"]["connectorContract"] != "fetch-render"
        || manifest["repoql"].get("connectorAbi").is_some()
    {
        return Err("INVALID_REPOQL_PIN");
    }
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
    .any(|key| manifest["features"][*key] != true)
        || manifest["rustOfficeFeature"] != true
        || manifest["features"]["ghost"] != false
        || manifest["rustGhostFeature"] != false
    {
        return Err("INVALID_VARIANT_FEATURES");
    }
    let receipts = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or("INVALID_FILE_RECEIPTS")?;
    if receipts.is_empty() || receipts.len() > MAX_FILES {
        return Err("INVALID_FILE_RECEIPTS");
    }
    let mut seen = HashSet::new();
    let mut paths = HashSet::new();
    let mut checksums = BTreeMap::new();
    let mut total = 0u64;
    for item in receipts {
        let name = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or("INVALID_FILE_RECEIPTS")?;
        let expected = item
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or("INVALID_FILE_RECEIPTS")?;
        let bytes = item
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or("INVALID_FILE_RECEIPTS")?;
        if !safe_member(name)
            || name == MANIFEST
            || name.len() > 240
            || !seen.insert(name.to_ascii_lowercase())
        {
            return Err("UNSAFE_OR_DUPLICATE_PATH");
        }
        if expected.len() != 64
            || !expected.as_bytes().iter().all(u8::is_ascii_hexdigit)
            || bytes > MAX_MEMBER
        {
            return Err("INVALID_FILE_RECEIPTS");
        }
        total = total.checked_add(bytes).ok_or("SOURCE_BUDGET_EXCEEDED")?;
        if total > MAX_TOTAL {
            return Err("SOURCE_BUDGET_EXCEEDED");
        }
        paths.insert(name);
        // Canonical comparison catches symlink/junction escapes; existing
        // Windows PowerShell stage ownership and reparse guards remain required.
        let location = root.join(name);
        let canonical = fs::canonicalize(&location).map_err(|_| "MISSING_OR_UNREADABLE_FILE")?;
        if !canonical.starts_with(&canonical_root) {
            return Err("SOURCE_PATH_ESCAPES_ROOT");
        }
        let data = bounded_read(&location, MAX_MEMBER)?;
        if data.len() as u64 != bytes || hash(&data) != expected.to_ascii_lowercase() {
            return Err("SOURCE_HASH_OR_SIZE_DRIFT");
        }
        if name != SUMS {
            checksums.insert(name.to_string(), expected.to_ascii_lowercase());
        }
    }
    if !seen.contains(&SUMS.to_ascii_lowercase()) {
        return Err("CHECKSUM_FILE_MISSING");
    }
    let sum_bytes = bounded_read(&root.join(SUMS), MAX_MEMBER)?;
    let sum_text = std::str::from_utf8(&sum_bytes).map_err(|_| "CHECKSUM_FORMAT_INVALID")?;
    let mut listed = BTreeMap::new();
    for line in sum_text.lines() {
        let (digest, name) = line.split_once("  ").ok_or("CHECKSUM_FORMAT_INVALID")?;
        if digest.len() != 64
            || !digest.as_bytes().iter().all(u8::is_ascii_hexdigit)
            || !safe_member(name)
            || listed
                .insert(name.to_string(), digest.to_ascii_lowercase())
                .is_some()
        {
            return Err("CHECKSUM_FORMAT_INVALID");
        }
    }
    if listed != checksums {
        return Err("CHECKSUM_INVENTORY_DRIFT");
    }
    // The receipt must describe the entire extracted source tree, not just a
    // subset of selected files. Otherwise an untracked executable could be
    // added after archive validation and bypass the receipt hash check.
    for entry in WalkDir::new(root).follow_links(false).into_iter() {
        let entry = entry.map_err(|_| "SOURCE_TREE_UNREADABLE")?;
        let path = entry.path();
        if path == root {
            continue;
        }
        let name = path
            .strip_prefix(root)
            .map_err(|_| "SOURCE_PATH_ESCAPES_ROOT")?
            .to_str()
            .ok_or("UNSAFE_OR_DUPLICATE_PATH")?
            .replace('\\', "/");
        if !safe_member(&name) {
            return Err("UNSAFE_OR_DUPLICATE_PATH");
        }
        let meta = fs::symlink_metadata(path).map_err(|_| "SOURCE_TREE_UNREADABLE")?;
        if !plain(&meta) {
            return Err("SOURCE_TREE_CONTAINS_LINK");
        }
        if entry.file_type().is_file() && name != MANIFEST && !paths.remove(name.as_str()) {
            return Err("UNTRACKED_SOURCE_FILE");
        }
        if !entry.file_type().is_file() && !entry.file_type().is_dir() {
            return Err("UNSUPPORTED_SOURCE_TREE_MEMBER");
        }
    }
    if !paths.is_empty() {
        return Err("SOURCE_TREE_INVENTORY_DRIFT");
    }
    Ok((variant, receipts.len()))
}

pub fn verify(root: &Path) -> (Value, bool) {
    match check(root) {
        Ok((variant, checked)) => (
            json!({"ok":true,"variant":variant,"checked":checked,
          "releaseReady":false,"acceptance":"NOT_RUN_NATIVE_WINDOWS"}),
            true,
        ),
        Err(code) => (
            json!({"ok":false,"code":code,"releaseReady":false,
          "acceptance":"NOT_RUN_NATIVE_WINDOWS"}),
            false,
        ),
    }
}

fn valid_sha(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn snapshot_check(root: &Path) -> Result<(usize, usize), &'static str> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| c == std::path::Component::ParentDir)
        || !root
            .ancestors()
            .all(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && plain(&m)))
    {
        return Err("SNAPSHOT_ROOT_UNSAFE");
    }
    #[cfg(windows)]
    if !matches!(root.components().next(), Some(std::path::Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return Err("SNAPSHOT_ROOT_UNSAFE");
    }
    let raw = bounded_read(&root.join(SNAPSHOT), 32 * 1024)?;
    // Windows PowerShell 5.1 Set-Content -Encoding UTF8 includes a BOM.
    let receipt: Value =
        serde_json::from_slice(raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw))
            .map_err(|_| "SNAPSHOT_RECEIPT_INVALID")?;
    if receipt["schema"] != 1
        || receipt["state"] != "STAGED_UNVERIFIED"
        || receipt["option"] != 2
        || receipt["repoqlVersion"] != "1.7.18"
        || receipt["acceptedOnWindows"] != false
        || receipt["servicesInstalled"] != false
        || receipt["guiConfigured"] != false
    {
        return Err("SNAPSHOT_RECEIPT_INVALID");
    }
    for (subdir, code) in [
        ("source", "SNAPSHOT_SOURCE_UNSAFE"),
        ("bin", "SNAPSHOT_BIN_UNSAFE"),
    ] {
        let meta = fs::symlink_metadata(root.join(subdir)).map_err(|_| code)?;
        if !meta.is_dir() || !plain(&meta) {
            return Err(code);
        }
    }
    let manifest_sha =
        valid_sha(&receipt["sourceManifestSha256"]).ok_or("SNAPSHOT_RECEIPT_INVALID")?;
    let source = root.join("source");
    let manifest = bounded_read(&source.join(MANIFEST), MAX_MANIFEST)?;
    if !hash(&manifest).eq_ignore_ascii_case(manifest_sha) {
        return Err("SNAPSHOT_MANIFEST_DRIFT");
    }
    let (_, files) = check(&source)?;
    let mut binaries = BTreeMap::new();
    binaries.insert(
        BRIDGE,
        valid_sha(&receipt["bridgeSha256"]).ok_or("SNAPSHOT_RECEIPT_INVALID")?,
    );
    if !receipt["supervisorSha256"].is_null() {
        binaries.insert(
            SUPERVISOR,
            valid_sha(&receipt["supervisorSha256"]).ok_or("SNAPSHOT_RECEIPT_INVALID")?,
        );
    }
    if let Some(optional) = receipt.get("additionalBinaries") {
        let rows = optional.as_array().ok_or("SNAPSHOT_RECEIPT_INVALID")?;
        if rows.len() > OPTIONAL.len() {
            return Err("SNAPSHOT_RECEIPT_INVALID");
        }
        for row in rows {
            let path = row["path"]
                .as_str()
                .filter(|p| OPTIONAL.contains(p))
                .ok_or("SNAPSHOT_RECEIPT_INVALID")?;
            let sha = valid_sha(&row["sha256"]).ok_or("SNAPSHOT_RECEIPT_INVALID")?;
            if binaries.insert(path, sha).is_some() {
                return Err("SNAPSHOT_RECEIPT_INVALID");
            }
        }
    }
    let actual = |dir: &Path| -> Result<HashSet<String>, &'static str> {
        fs::read_dir(dir)
            .map_err(|_| "SNAPSHOT_INVENTORY_UNREADABLE")?
            .take(32)
            .map(|item| {
                item.map_err(|_| "SNAPSHOT_INVENTORY_UNREADABLE")
                    .and_then(|entry| {
                        entry
                            .file_name()
                            .into_string()
                            .map_err(|_| "SNAPSHOT_INVENTORY_UNREADABLE")
                    })
            })
            .collect()
    };
    if actual(root)?
        != [SNAPSHOT, "bin", "source"]
            .into_iter()
            .map(String::from)
            .collect()
        || actual(&root.join("bin"))? != binaries.keys().map(|p| p[4..].to_owned()).collect()
    {
        return Err("SNAPSHOT_UNTRACKED_MEMBER");
    }
    for (rel, expected) in &binaries {
        let path = root.join(rel);
        let metadata = fs::symlink_metadata(&path).map_err(|_| "SNAPSHOT_BINARY_UNREADABLE")?;
        const BIN_LIMIT: u64 = 100 * 1024 * 1024;
        if !plain(&metadata)
            || !metadata.is_file()
            || metadata.len() > BIN_LIMIT
            || metadata.len() == 0
        {
            return Err("SNAPSHOT_BINARY_UNSAFE");
        }
        let mut digest = Sha256::new();
        let bytes = io::copy(
            &mut File::open(path)
                .map_err(|_| "SNAPSHOT_BINARY_UNREADABLE")?
                .take(BIN_LIMIT + 1),
            &mut digest,
        )
        .map_err(|_| "SNAPSHOT_BINARY_UNREADABLE")?;
        if bytes != metadata.len() || !hex::encode(digest.finalize()).eq_ignore_ascii_case(expected)
        {
            return Err("SNAPSHOT_BINARY_DRIFT");
        }
    }
    Ok((files, binaries.len()))
}

// The phase driver owns consent and the per-user ACL. This command owns
// only three fixed sibling names. A failed promotion preserves the pending
// directory and restores the original current snapshot when possible.
pub fn promote_pending(root: &Path, pending_name: &str) -> Result<(), &'static str> {
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("PROMOTION_ROOT_INVALID")?;
        let base = std::path::PathBuf::from(local).join("Singularity");
        // The production driver passes a canonical local path beneath its
        // current user's state directory, not the directory itself.
        if !root.strip_prefix(&base).is_ok_and(|p| {
            !p.as_os_str().is_empty()
                && p.components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
        }) {
            return Err("PROMOTION_ROOT_INVALID");
        }
    }
    promote_transaction(root, pending_name, move_without_replace)
}

fn promote_transaction(
    root: &Path,
    pending_name: &str,
    move_path: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<(), &'static str> {
    let suffix = pending_name
        .strip_prefix(".pending-")
        .ok_or("PROMOTION_PENDING_NAME_INVALID")?;
    if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("PROMOTION_PENDING_NAME_INVALID");
    }
    let pending = root.join(pending_name);
    snapshot_check(&pending)?;
    let current = root.join("current");
    let previous = root.join("previous");
    if present(&previous)? {
        return Err("PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS");
    }
    let had_current = present(&current)?;
    if had_current {
        snapshot_check(&current).map_err(|_| "RUST_PREVIOUS_SNAPSHOT_VERIFICATION_FAILED")?;
        move_path(&current, &previous).map_err(|_| "PROMOTION_PRESERVE_CURRENT_FAILED")?;
    }
    if move_path(&pending, &current).is_err() {
        if had_current && move_path(&previous, &current).is_err() {
            return Err("STAGE_RECOVERY_INCOMPLETE_REVIEW_PREVIOUS_AND_PENDING");
        }
        return Err("PROMOTION_MOVE_FAILED");
    }
    Ok(())
}

fn present(path: &Path) -> Result<bool, &'static str> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("PROMOTION_PATH_UNREADABLE"),
    }
}

#[cfg(windows)]
fn move_without_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
    }
    let from: Vec<_> = from.as_os_str().encode_wide().chain([0]).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain([0]).collect();
    // Unlike MoveFileEx with replacement, this cannot clobber a destination
    // created by another process between the inventory check and the move.
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_without_replace(from: &Path, to: &Path) -> io::Result<()> {
    // Linux test backend only. Production CLI refuses all non-Windows hosts.
    if present(to).map_err(io::Error::other)? {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

pub fn verify_snapshot(root: &Path) -> (Value, bool) {
    match snapshot_check(root) {
        Ok((files, binaries)) => (
            json!({"ok":true,"sourceFiles":files,"binaries":binaries,"releaseReady":false}),
            true,
        ),
        Err(code) => (json!({"ok":false,"code":code,"releaseReady":false}), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    fn fixture(root: &Path) {
        fs::write(root.join("sample.txt"), b"sample").unwrap();
        let sha = hash(b"sample");
        let sums = format!("{sha}  sample.txt\n");
        fs::write(root.join(SUMS), &sums).unwrap();
        let manifest = json!({"schema":1,"variant":2,
           "release_status":"SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER",
           "production_feature_parity":"UNVERIFIED","acceptance":"NOT_RUN_ON_NATIVE_WINDOWS",
           "repoql":{"requiredVersion":"1.7.18","connectorContract":"fetch-render"},
           "features":{"office":true,"repoql_dashboard":true,"tencent_connector":true,"kanzo":true,"openmausbot":true,"memory":true,"repoql_mcp":true,"ghost":false},
           "rustOfficeFeature":true,"rustGhostFeature":false,
           "files":[{"path":"sample.txt","sha256":sha,"bytes":6},
                    {"path":SUMS,"sha256":hash(sums.as_bytes()),"bytes":sums.len()}]});
        fs::write(root.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
    fn staged_fixture(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::create_dir(root.join("source")).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        fixture(&root.join("source"));
        let manifest = fs::read(root.join("source").join(MANIFEST)).unwrap();
        fs::write(root.join(BRIDGE), b"synthetic bridge").unwrap();
        fs::write(root.join(SUPERVISOR), b"synthetic supervisor").unwrap();
        let receipt = json!({"schema":1,"state":"STAGED_UNVERIFIED","option":2,
            "repoqlVersion":"1.7.18","sourceManifestSha256":hash(&manifest),
            "bridgeSha256":hash(b"synthetic bridge"),"supervisorSha256":hash(b"synthetic supervisor"),
            "acceptedOnWindows":false,"servicesInstalled":false,"guiConfigured":false});
        let mut receipt_bytes = vec![0xef, 0xbb, 0xbf];
        receipt_bytes.extend(serde_json::to_vec(&receipt).unwrap());
        fs::write(root.join(SNAPSHOT), receipt_bytes).unwrap();
    }

    #[test]
    fn staged_promotion_preserves_current_and_refuses_conflicts() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let name = ".pending-0123456789abcdef0123456789abcdef";
        let pending = root.join(name);
        let current = root.join("current");
        let previous = root.join("previous");
        staged_fixture(&pending);
        assert_eq!(
            promote_transaction(root, "../current", move_without_replace),
            Err("PROMOTION_PENDING_NAME_INVALID")
        );
        assert_eq!(
            promote_transaction(root, name, move_without_replace),
            Ok(())
        );
        assert!(!pending.exists());
        assert!(current.exists());
        assert!(!previous.exists());
        staged_fixture(&pending);
        fs::write(current.join("bin/foreign.exe"), b"foreign").unwrap();
        assert_eq!(
            promote_transaction(root, name, move_without_replace),
            Err("RUST_PREVIOUS_SNAPSHOT_VERIFICATION_FAILED")
        );
        assert!(current.exists() && pending.exists() && !previous.exists());
        fs::remove_file(current.join("bin/foreign.exe")).unwrap();
        assert_eq!(
            promote_transaction(root, name, move_without_replace),
            Ok(())
        );
        assert!(previous.exists() && current.exists() && !pending.exists());
        staged_fixture(&pending);
        assert_eq!(
            promote_transaction(root, name, move_without_replace),
            Err("PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS")
        );
        assert!(previous.exists() && current.exists() && pending.exists());
    }

    #[test]
    fn failed_promotion_restores_previous_without_removing_pending() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let name = ".pending-0123456789abcdef0123456789abcdef";
        let pending = root.join(name);
        let current = root.join("current");
        let previous = root.join("previous");
        staged_fixture(&pending);
        staged_fixture(&current);
        assert_eq!(
            promote_transaction(root, name, |from, to| {
                if from == pending {
                    Err(io::ErrorKind::PermissionDenied.into())
                } else {
                    move_without_replace(from, to)
                }
            }),
            Err("PROMOTION_MOVE_FAILED")
        );
        assert!(pending.exists() && current.exists() && !previous.exists());
        assert_eq!(
            promote_transaction(root, name, |from, to| {
                if from == pending || from == previous {
                    Err(io::ErrorKind::PermissionDenied.into())
                } else {
                    move_without_replace(from, to)
                }
            }),
            Err("STAGE_RECOVERY_INCOMPLETE_REVIEW_PREVIOUS_AND_PENDING")
        );
        assert!(pending.exists() && !current.exists() && previous.exists());
    }

    #[test]
    fn verifies_staging_inventory_before_promotion() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        staged_fixture(root);
        assert_eq!(snapshot_check(root), Ok((2, 2)));
        fs::write(root.join("bin/foreign.exe"), b"foreign").unwrap();
        assert_eq!(snapshot_check(root), Err("SNAPSHOT_UNTRACKED_MEMBER"));
        fs::remove_file(root.join("bin/foreign.exe")).unwrap();
        fs::write(root.join(SUPERVISOR), b"changed").unwrap();
        assert_eq!(snapshot_check(root), Err("SNAPSHOT_BINARY_DRIFT"));
        fs::write(root.join(SUPERVISOR), b"synthetic supervisor").unwrap();
        fs::write(root.join("source").join(MANIFEST), b"changed").unwrap();
        assert_eq!(snapshot_check(root), Err("SNAPSHOT_MANIFEST_DRIFT"));
    }

    #[test]
    fn verifies_valid_bundle_and_rejects_drift() {
        let dir = tempdir().unwrap();
        fixture(dir.path());
        assert!(verify(dir.path()).1);
        fs::write(dir.path().join("sample.txt"), b"tamper").unwrap();
        assert_eq!(verify(dir.path()).0["code"], "SOURCE_HASH_OR_SIZE_DRIFT");
    }
    #[test]
    fn refuses_untracked_source_files() {
        let dir = tempdir().unwrap();
        fixture(dir.path());
        fs::write(dir.path().join("unlisted.js"), b"not part of receipt").unwrap();
        assert_eq!(verify(dir.path()).0["code"], "UNTRACKED_SOURCE_FILE");
    }
    #[test]
    fn refuses_parent_traversal() {
        let dir = tempdir().unwrap();
        fixture(dir.path());
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(dir.path().join(MANIFEST)).unwrap()).unwrap();
        manifest["files"][0]["path"] = json!("../outside.txt");
        fs::write(
            dir.path().join(MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(verify(dir.path()).0["code"], "UNSAFE_OR_DUPLICATE_PATH");
    }
}
