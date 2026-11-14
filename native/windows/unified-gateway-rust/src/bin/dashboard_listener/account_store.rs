//! The existing private dashboard state directory remains the storage boundary.
//! The native account file is byte-compatible with the Python v1 file.
use base64::{engine::general_purpose::STANDARD, Engine};
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use subtle::ConstantTimeEq;

const ACCOUNT_LIMIT: u64 = 4096;

#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields, rename_all = "snake_case")]
enum Request {
    Configured {
        state: PathBuf,
    },
    PasswordMode {
        state: PathBuf,
    },
    Create {
        state: PathBuf,
        username: String,
        password: String,
        salt: [u8; 16],
    },
    Verify {
        state: PathBuf,
        username: Option<String>,
        password: String,
    },
    SetMode {
        state: PathBuf,
        mode: Mode,
        nonce: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    Password,
    AutoLocal,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Account {
    version: u8,
    username: String,
    salt: String,
    hash: String,
}

fn plain(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !meta.file_type().is_symlink()
}

fn validate_state(state: &Path) -> Result<(), &'static str> {
    if !state.is_absolute() || state.components().any(|c| c == Component::ParentDir) {
        return Err("account_path_reparse_refused");
    }
    #[cfg(windows)]
    if !matches!(state.components().next(), Some(Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return Err("account_path_reparse_refused");
    }
    for path in state.ancestors() {
        let info = fs::symlink_metadata(path).map_err(|_| "account_file_invalid")?;
        if !plain(&info) || !info.is_dir() {
            return Err("account_path_reparse_refused");
        }
    }
    Ok(())
}

fn account_exists(path: &Path) -> Result<bool, &'static str> {
    match fs::symlink_metadata(path) {
        Ok(meta) if plain(&meta) && meta.is_file() => Ok(true),
        Ok(meta) if !plain(&meta) => Err("account_path_reparse_refused"),
        Ok(_) => Err("account_file_invalid"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("account_file_invalid"),
    }
}

fn valid_user(name: &str) -> bool {
    (3..=40).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphabetic()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32], &'static str> {
    let mut digest = [0; 32];
    scrypt(
        password.as_bytes(),
        salt,
        &Params::new(14, 8, 1, 32).map_err(|_| "account_file_invalid")?,
        &mut digest,
    )
    .map_err(|_| "account_file_invalid")?;
    Ok(digest)
}

// Create a private sibling before publishing a complete record. Opening with
// create_new refuses existing names and does not truncate foreign files.
fn private_create(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn publish(target: &Path, temp: &Path, bytes: &[u8], replace: bool) -> io::Result<()> {
    let mut file = private_create(temp)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| {
        if replace {
            fs::rename(temp, target)
        } else {
            // The destination must never replace an existing account, even
            // if another process creates it after our preliminary check.
            fs::hard_link(temp, target)
        }
    });
    let _ = fs::remove_file(temp);
    result
}

fn verify_record(
    path: &Path,
    username: Option<String>,
    password: &str,
) -> Result<bool, &'static str> {
    if !account_exists(path)? {
        return Err("account_file_invalid");
    }
    let mut raw = Vec::new();
    File::open(path)
        .and_then(|f| f.take(ACCOUNT_LIMIT + 1).read_to_end(&mut raw))
        .map_err(|_| "account_file_invalid")?;
    if raw.len() as u64 > ACCOUNT_LIMIT {
        return Err("account_file_invalid");
    }
    let doc: Account = serde_json::from_slice(&raw).map_err(|_| "account_file_invalid")?;
    if doc.version != 1 || !valid_user(&doc.username) {
        return Err("account_file_invalid");
    }
    let salt = STANDARD
        .decode(doc.salt)
        .map_err(|_| "account_file_invalid")?;
    let hash = STANDARD
        .decode(doc.hash)
        .map_err(|_| "account_file_invalid")?;
    if salt.len() != 16 || hash.len() != 32 {
        return Err("account_file_invalid");
    }
    if password.len() > 1024 || password.chars().count() > 256 {
        return Err("invalid_credentials");
    }
    let digest = derive(password, &salt)?;
    Ok(bool::from(digest.as_slice().ct_eq(&hash))
        && username
            .as_ref()
            .is_some_and(|name| bool::from(doc.username.as_bytes().ct_eq(name.as_bytes()))))
}

fn password_mode(path: &Path) -> Result<bool, &'static str> {
    if !account_exists(path)? {
        return Ok(false);
    }
    let mut raw = Vec::new();
    if File::open(path)
        .and_then(|file| file.take(ACCOUNT_LIMIT + 1).read_to_end(&mut raw))
        .is_err()
        || raw.len() as u64 > ACCOUNT_LIMIT
    {
        return Ok(false);
    }
    // Preserve the previous host behavior: absent or malformed mode falls
    // back to auto-local. Reparse paths are always errors, not defaults.
    Ok(serde_json::from_slice::<serde_json::Value>(&raw)
        .ok()
        .is_some_and(|value| value["mode"] == "password"))
}

fn execute(req: Request) -> Result<bool, &'static str> {
    let state = match &req {
        Request::Configured { state }
        | Request::PasswordMode { state }
        | Request::Create { state, .. }
        | Request::Verify { state, .. }
        | Request::SetMode { state, .. } => state,
    };
    validate_state(state)?;
    let account = state.join("local-account.json");
    match req {
        Request::Configured { .. } => account_exists(&account),
        Request::PasswordMode { .. } => password_mode(&state.join("auth-mode.json")),
        Request::Create {
            username,
            password,
            salt,
            ..
        } => {
            if !valid_user(&username) {
                return Err("invalid_username");
            }
            if !(12..=256).contains(&password.chars().count())
                || password.len() > 1024
                || password.bytes().any(|b| b < 32)
            {
                return Err("invalid_password");
            }
            if account_exists(&account)? {
                return Err("account_already_configured");
            }
            let hash = derive(&password, &salt)?;
            let doc = Account {
                version: 1,
                username,
                salt: STANDARD.encode(salt),
                hash: STANDARD.encode(hash),
            };
            let bytes = serde_json::to_vec(&doc).map_err(|_| "account_file_invalid")?;
            let temp = account.with_file_name(format!(
                ".local-account-{}.tmp",
                STANDARD.encode(salt).replace(['/', '+', '='], "_")
            ));
            publish(&account, &temp, &bytes, false).map_err(|e| {
                if e.kind() == io::ErrorKind::AlreadyExists && account_exists(&account) == Ok(true)
                {
                    "account_already_configured"
                } else {
                    "account_file_invalid"
                }
            })?;
            Ok(true)
        }
        Request::Verify {
            username, password, ..
        } => verify_record(&account, username, &password),
        Request::SetMode { mode, nonce, .. } => {
            if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("auth_mode_write_failed");
            }
            account_exists(&account)?;
            let mode_path = account.with_file_name("auth-mode.json");
            account_exists(&mode_path)?;
            let temp = account.with_file_name(format!(".auth-mode-{nonce}.tmp"));
            let bytes = serde_json::to_vec(&json!({"version":1,"mode":mode}))
                .map_err(|_| "auth_mode_write_failed")?;
            publish(&mode_path, &temp, &bytes, true).map_err(|_| "auth_mode_write_failed")?;
            Ok(true)
        }
    }
}

pub fn run() -> io::Result<()> {
    let mut data = Vec::new();
    io::stdin().take(8193).read_to_end(&mut data)?;
    if data.len() > 8192 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let req: Request = serde_json::from_slice(&data).map_err(|_| io::ErrorKind::InvalidInput)?;
    let response = match execute(req) {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(code) => json!({"ok":false,"code":code}),
    };
    writeln!(io::stdout().lock(), "{response}")
}
