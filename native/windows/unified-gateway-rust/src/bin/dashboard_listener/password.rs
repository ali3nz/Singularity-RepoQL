//! One password operation on stdin. No browser cookie, path, or account name
//! is needed for derivation. Keep the existing v1 scrypt parameters.
use scrypt::{scrypt, Params};
use serde::Deserialize;
use std::io::{self, Read, Write};
use subtle::ConstantTimeEq;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, tag = "op", rename_all = "snake_case")]
enum Operation {
    Derive {
        password: String,
        salt: [u8; 16],
    },
    Verify {
        password: String,
        salt: [u8; 16],
        expected: [u8; 32],
    },
}

fn process(op: Operation) -> Option<Vec<u8>> {
    let (password, salt, expected) = match op {
        Operation::Derive { password, salt } => (password, salt, None),
        Operation::Verify {
            password,
            salt,
            expected,
        } => (password, salt, Some(expected)),
    };
    if password.len() > 1024 || password.chars().count() > 256 {
        return None;
    }
    let mut digest = [0; 32];
    scrypt(
        password.as_bytes(),
        &salt,
        &Params::new(14, 8, 1, 32).ok()?,
        &mut digest,
    )
    .ok()?;
    Some(match expected {
        None => digest.to_vec(),
        Some(expected) => vec![u8::from(bool::from(digest.ct_eq(&expected)))],
    })
}

pub fn run() -> io::Result<()> {
    let mut raw = Vec::new();
    io::stdin().take(4097).read_to_end(&mut raw)?;
    if raw.len() > 4096 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let response = serde_json::from_slice(&raw)
        .ok()
        .and_then(process)
        .ok_or(io::ErrorKind::InvalidInput)?;
    io::stdout().write_all(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_wire_is_rejected() {
        assert!(serde_json::from_str::<Operation>(
            r#"{"op":"derive","password":"fixture","salt":[]}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Operation>(r#"{"op":"derive","password":"fixture","salt":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"username":"extra"}"#).is_err());
    }

    #[test]
    fn password_bounds_match_existing_record_limits() {
        assert!(process(Operation::Derive {
            password: "a".repeat(257),
            salt: [0; 16]
        })
        .is_none());
    }
}
