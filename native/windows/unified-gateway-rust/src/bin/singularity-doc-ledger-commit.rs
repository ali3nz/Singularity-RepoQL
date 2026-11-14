//! Atomic publication of a flushed documentation ledger under its existing
//! Python/Node owner lock. No remote calls, auto recovery or lock creation.
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: String,
    temp: PathBuf,
    owner: String,
}

fn plain(path: &Path) -> Result<fs::Metadata, &'static str> {
    let info = fs::symlink_metadata(path).map_err(|_| "PATH_UNAVAILABLE")?;
    if info.file_type().is_symlink() {
        return Err("LINK_REFUSED");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err("REPARSE_REFUSED");
        }
    }
    Ok(info)
}

fn require_dir(path: &Path) -> Result<(), &'static str> {
    if plain(path)?.is_dir() {
        Ok(())
    } else {
        Err("DIRECTORY_REQUIRED")
    }
}

fn valid_owner(owner: &str) -> bool {
    let token = owner.as_bytes();
    match token.len() {
        32 => token.iter().all(u8::is_ascii_hexdigit),
        36 => token.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        }),
        _ => false,
    }
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    // Same-directory move only. Do not fall back to copy/delete.
    const MOVEFILE_REPLACE_EXISTING: u32 = 1;
    const MOVEFILE_WRITE_THROUGH: u32 = 8;
    let source = wide(source);
    let target = wide(target);
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err("ATOMIC_REPLACE_FAILED");
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    fs::rename(source, target).map_err(|_| "ATOMIC_REPLACE_FAILED")
}

fn commit(request: &Request) -> Result<(), &'static str> {
    if request.schema != "singularity-doc-ledger-commit/v1" || !valid_owner(&request.owner) {
        return Err("INVALID_REQUEST");
    }
    let temp = &request.temp;
    if !temp.is_absolute()
        || !matches!(temp.to_str(), Some(p) if !p.contains('\0'))
        || temp
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("INVALID_TEMP_PATH");
    }
    #[cfg(windows)]
    if !matches!(temp.components().next(), Some(std::path::Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return Err("INVALID_TEMP_PATH");
    }
    let name = temp
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("INVALID_TEMP_PATH")?;
    let suffix = name
        .strip_prefix(".ledger-")
        .and_then(|s| s.strip_suffix(".tmp"))
        .ok_or("INVALID_TEMP_PATH")?;
    if suffix.is_empty()
        || suffix.len() > 80
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("INVALID_TEMP_PATH");
    }
    let dir = temp.parent().ok_or("INVALID_TEMP_PATH")?;
    if dir.file_name().and_then(|s| s.to_str()) != Some("doc-index") {
        return Err("INVALID_LEDGER_DIRECTORY");
    }
    for parent in dir.ancestors() {
        require_dir(parent)?;
    }
    if !plain(temp)?.is_file() {
        return Err("TEMP_FILE_REQUIRED");
    }
    let target = dir.join("ledger.json");
    match fs::symlink_metadata(&target) {
        Ok(_) if !plain(&target)?.is_file() => return Err("LEDGER_FILE_REQUIRED"),
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err("LEDGER_PATH_UNAVAILABLE"),
    }
    let lock = dir.join(".ledger.lock.d");
    require_dir(&lock)?;
    let owner_file = lock.join("owner");
    if !plain(&owner_file)?.is_file() {
        return Err("OWNER_FILE_REQUIRED");
    }
    let mut owner = Vec::new();
    fs::File::open(owner_file)
        .and_then(|f| f.take(37).read_to_end(&mut owner))
        .map_err(|_| "OWNER_READ_FAILED")?;
    if owner != request.owner.as_bytes() {
        return Err("LEDGER_OWNER_CHANGED");
    }
    replace(temp, &target)
}

fn main() {
    let mut bytes = Vec::new();
    let result = match io::stdin().take(16_385).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() <= 16_384 => serde_json::from_slice::<Request>(&bytes)
            .map_err(|_| "INVALID_REQUEST")
            .and_then(|r| commit(&r)),
        _ => Err("INPUT_LIMIT"),
    };
    match result {
        Ok(()) => println!("{}", json!({"ok":true,"published":true})),
        Err(code) => {
            println!("{}", json!({"ok":false,"code":code}));
            std::process::exit(2);
        }
    }
}
