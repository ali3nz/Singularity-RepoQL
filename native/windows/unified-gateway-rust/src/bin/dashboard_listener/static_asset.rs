//! Windows dashboard static asset selection and bounded file I/O. The host
//! still owns route authorization, the account page choice and HTML injection.
use serde::Deserialize;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: PathBuf,
    relative: String,
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

fn valid_relative(value: &str) -> bool {
    value.len() <= 4096
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.ends_with('.')
                && !part.ends_with(' ')
                && !part.bytes().any(|b| {
                    b < 32 || matches!(b, b'\\' | b':' | b'*' | b'?' | b'<' | b'>' | b'|' | b'"')
                })
                && !matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "CONIN$"
                        | "CONOUT$"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
}

fn asset(root: &Path, relative: &str) -> Option<PathBuf> {
    if !valid_relative(relative) {
        return None;
    }
    let mut current = root.to_path_buf();
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        current.push(part);
        let info = fs::symlink_metadata(&current).ok()?;
        if !plain(&info) || (parts.peek().is_some() && !info.is_dir()) {
            return None;
        }
        if parts.peek().is_none() && !info.is_file() {
            return None;
        }
    }
    Some(current)
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

fn resolve(req: Request) -> io::Result<Option<(bool, &'static str, Vec<u8>)>> {
    if !req.root.is_absolute()
        || req
            .root
            .components()
            .any(|c| c == std::path::Component::ParentDir)
        || !req
            .root
            .ancestors()
            .all(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && plain(&m)))
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(windows)]
    if !matches!(req.root.components().next(), Some(std::path::Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let Some(path) = asset(&req.root, &req.relative).or_else(|| asset(&req.root, "index.html"))
    else {
        return Ok(None);
    };
    let input = File::open(&path)?;
    let mut bytes = Vec::new();
    input.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Some((
        path.file_name().is_some_and(|n| n == "index.html"),
        mime(&path),
        bytes,
    )))
}

pub fn run() -> io::Result<()> {
    let mut raw = Vec::new();
    io::stdin().take(8193).read_to_end(&mut raw)?;
    if raw.len() > 8192 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let request = serde_json::from_slice(&raw).map_err(|_| io::ErrorKind::InvalidInput)?;
    let mut out = io::stdout().lock();
    match resolve(request)? {
        Some((index, mime, bytes)) => {
            writeln!(out, "{}:{mime}", u8::from(index))?;
            out.write_all(&bytes)?;
        }
        None => writeln!(out, "NOT_FOUND")?,
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_aliases_and_traversal_without_path_join() {
        for value in [
            "",
            "/",
            "../index.html",
            "assets//x",
            "./x",
            "C:\\file",
            "a:b",
            "a/aux.txt",
            "assets/.. /x",
            "index.html.",
        ] {
            assert!(!valid_relative(value), "{value}");
        }
        assert!(valid_relative("assets/mobile/tile.png"));
    }
}
