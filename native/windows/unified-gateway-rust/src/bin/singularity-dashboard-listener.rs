//! Optional Windows dashboard TCP listener. Forward the stream unchanged so the
//! existing HTTP, WebSocket, authentication and mutation owners stay in control.
#[path = "dashboard_listener/account_store.rs"]
mod account_store;
#[path = "dashboard_listener/password.rs"]
mod password;
#[path = "dashboard_listener/read_api.rs"]
mod read_api;
#[path = "dashboard_listener/static_asset.rs"]
mod static_asset;

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

const MAX_CONNECTIONS: usize = 128;
const PREFACE: &str = "SINGULARITY_DASHBOARD_V1 ";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    port: u16,
    backend_port: u16,
    key: String,
    reply_key: String,
}

fn valid(config: &Config) -> bool {
    (config.port == 0 || config.port >= 1024)
        && config.backend_port >= 1024
        && config.port != config.backend_port
        && config.key != config.reply_key
        && [&config.key, &config.reply_key].into_iter().all(|key| {
            key.len() == 64
                && key
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn copy_half(mut source: &TcpStream, mut dest: &TcpStream) {
    if io::copy(&mut source, &mut dest).is_ok() {
        // Preserve EOF-delimited responses and reverse traffic after a half close.
        let _ = dest.shutdown(Shutdown::Write);
    } else {
        let _ = source.shutdown(Shutdown::Both);
        let _ = dest.shutdown(Shutdown::Both);
    }
}

fn relay(client: TcpStream, backend_port: u16, preface: &[u8], reply_key: &[u8]) -> io::Result<()> {
    // Accepted sockets can inherit the listener's nonblocking mode on Windows.
    // The bidirectional io::copy relay requires blocking streams.
    client.set_nonblocking(false)?;
    let backend = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, backend_port).into(),
        Duration::from_secs(3),
    )?;
    client.set_nodelay(true)?;
    backend.set_nodelay(true)?;
    backend.set_read_timeout(Some(Duration::from_secs(3)))?;
    backend.set_write_timeout(Some(Duration::from_secs(3)))?;
    (&backend).write_all(preface)?;
    let mut reply = [0; 65];
    (&backend).read_exact(&mut reply)?;
    let differs = reply[..64]
        .iter()
        .zip(reply_key)
        .fold(0, |acc, (a, b)| acc | (a ^ b));
    if differs != 0 || reply[64] != b'\n' {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    backend.set_read_timeout(None)?;
    backend.set_write_timeout(None)?;
    thread::scope(|scope| {
        if thread::Builder::new()
            .spawn_scoped(scope, || copy_half(&client, &backend))
            .is_ok()
        {
            copy_half(&backend, &client);
        }
    });
    Ok(())
}

struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, tag = "op", rename_all = "snake_case")]
enum SessionOp {
    Issue { key: String, now: f64, ttl: u32 },
    Valid { key: String, now: f64 },
    Revoke { key: String },
    Clear,
    Bearer { candidate: String, expected: String },
}

fn session_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn session_op(sessions: &mut HashMap<String, f64>, op: SessionOp) -> Option<bool> {
    match op {
        SessionOp::Issue { key, now, ttl }
            if session_key(&key)
                && now.is_finite()
                && now >= 0.0
                && (30..=28_800).contains(&ttl) =>
        {
            sessions.retain(|_, expire| *expire > now);
            // Bound state under repeated unauthenticated local navigations.
            if sessions.len() >= 16_384 {
                return None;
            }
            sessions.insert(key, now + f64::from(ttl));
            Some(true)
        }
        SessionOp::Valid { key, now } if session_key(&key) && now.is_finite() && now >= 0.0 => {
            Some(sessions.get(&key).is_some_and(|expires| *expires > now))
        }
        SessionOp::Revoke { key } if session_key(&key) => {
            sessions.remove(&key);
            Some(true)
        }
        SessionOp::Clear => {
            sessions.clear();
            Some(true)
        }
        SessionOp::Bearer {
            candidate,
            expected,
        } if session_key(&candidate) && session_key(&expected) => {
            use subtle::ConstantTimeEq;
            Some(bool::from(candidate.as_bytes().ct_eq(expected.as_bytes())))
        }
        _ => None,
    }
}

fn serve_sessions(mut control: impl BufRead, mut response: impl Write) -> io::Result<()> {
    let mut sessions = HashMap::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut bounded = io::Read::take(&mut control, 8200);
        let n = bounded.read_until(b'\n', &mut line)?;
        if n == 0 {
            return Ok(());
        }
        if !line.ends_with(b"\n") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        if let Some(raw) = line.strip_prefix(b"READ ") {
            match read_api::frame(raw) {
                Ok(body) => {
                    response.write_all(b"READ ")?;
                    response.write_all(&body)?;
                    response.write_all(b"\n")?;
                }
                Err(_) => response.write_all(b"REFUSED\n")?,
            }
            response.flush()?;
            continue;
        }
        let result = (line.len() <= 256)
            .then(|| serde_json::from_slice::<SessionOp>(&line))
            .transpose()
            .ok()
            .flatten()
            .and_then(|op| session_op(&mut sessions, op));
        response.write_all(match result {
            Some(true) => b"YES\n",
            Some(false) => b"NO\n",
            None => b"REFUSED\n",
        })?;
        response.flush()?;
    }
}

#[cfg(not(windows))]
fn bind_listener(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
}

#[cfg(windows)]
fn bind_listener(port: u16) -> io::Result<TcpListener> {
    use std::os::windows::io::{FromRawSocket, OwnedSocket};
    use windows_sys::Win32::Networking::WinSock::*;
    // Winsock allows overlapping bind in some reuse configurations. The
    // exclusive option is applied before bind, including for port zero.
    const SO_EXCLUSIVEADDRUSE: i32 = !SO_REUSEADDR;
    let mut startup = std::mem::MaybeUninit::<WSADATA>::uninit();
    let status = unsafe { WSAStartup(0x0202, startup.as_mut_ptr()) };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status));
    }
    // Winsock stays initialized for the life of this dedicated process.
    let raw = unsafe {
        WSASocketW(
            i32::from(AF_INET),
            SOCK_STREAM,
            IPPROTO_TCP,
            std::ptr::null(),
            0,
            WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT,
        )
    };
    if raw == INVALID_SOCKET {
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    let owned = unsafe { OwnedSocket::from_raw_socket(raw as _) };
    let enabled = 1i32;
    let address = SOCKADDR_IN {
        sin_family: AF_INET,
        sin_port: port.to_be(),
        sin_addr: IN_ADDR {
            S_un: IN_ADDR_0 {
                S_addr: u32::from_ne_bytes(Ipv4Addr::LOCALHOST.octets()),
            },
        },
        sin_zero: [0; 8],
    };
    if unsafe {
        setsockopt(
            raw,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&enabled as *const i32).cast(),
            4,
        ) != 0
            || bind(
                raw,
                (&address as *const SOCKADDR_IN).cast(),
                std::mem::size_of::<SOCKADDR_IN>() as i32,
            ) != 0
            || listen(raw, 32) != 0
    } {
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    Ok(TcpListener::from(owned))
}

fn serve() -> io::Result<()> {
    let mut control = BufReader::new(io::stdin());
    let mut line = Vec::new();
    // Read the bounded startup frame without including any secrets in argv.
    let mut bounded = io::Read::take(&mut control, 256);
    bounded.read_until(b'\n', &mut line)?;
    let config: Config = serde_json::from_slice(&line)
        .ok()
        .filter(valid)
        .filter(|_| line.ends_with(b"\n"))
        .ok_or(io::ErrorKind::InvalidInput)?;
    let listener = bind_listener(config.port)?;
    listener.set_nonblocking(true)?;
    let preface = Arc::new(format!("{PREFACE}{}\n", config.key));
    let reply_key = Arc::new(config.reply_key);
    let closing = Arc::new(AtomicBool::new(false));
    let control_closed = Arc::clone(&closing);
    {
        let mut out = io::stdout().lock();
        writeln!(out, "READY {}", listener.local_addr()?.port())?;
        out.flush()?;
    }
    thread::Builder::new().spawn(move || {
        // The session authority uses only hashed tokens and the parent's
        // monotonic clock. EOF also closes the listener after parent death.
        let _ = serve_sessions(control, io::stdout().lock());
        control_closed.store(true, Ordering::Release);
    })?;
    let active = Arc::new(AtomicUsize::new(0));
    while !closing.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((client, addr)) => {
                if !addr.ip().is_loopback() || active.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                    continue;
                }
                active.fetch_add(1, Ordering::Relaxed);
                let slot = Slot(Arc::clone(&active));
                let preface = Arc::clone(&preface);
                let reply_key = Arc::clone(&reply_key);
                let _ = thread::Builder::new().spawn(move || {
                    let _slot = slot;
                    let _ = relay(
                        client,
                        config.backend_port,
                        preface.as_bytes(),
                        reply_key.as_bytes(),
                    );
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let result = match (args.next(), args.next()) {
        (None, None) => serve(),
        (Some(mode), None) if mode == "--account-stdin" => account_store::run(),
        (Some(mode), None) if mode == "--password-stdin" => password::run(),
        (Some(mode), None) if mode == "--static-stdin" => static_asset::run(),
        _ => Err(io::ErrorKind::InvalidInput.into()),
    };
    if result.is_err() {
        eprintln!("DASHBOARD_NATIVE_OPERATION_FAILED");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_expire_and_clear_without_carrying_cookie_values() {
        let key = "a1".repeat(32);
        let mut sessions = HashMap::new();
        assert_eq!(
            session_op(
                &mut sessions,
                SessionOp::Issue {
                    key: key.clone(),
                    now: 1.0,
                    ttl: 30
                }
            ),
            Some(true)
        );
        assert_eq!(
            session_op(
                &mut sessions,
                SessionOp::Valid {
                    key: key.clone(),
                    now: 30.5
                }
            ),
            Some(true)
        );
        assert_eq!(
            session_op(
                &mut sessions,
                SessionOp::Valid {
                    key: key.clone(),
                    now: 31.0
                }
            ),
            Some(false)
        );
        assert_eq!(session_op(&mut sessions, SessionOp::Clear), Some(true));
        assert_eq!(
            session_op(&mut sessions, SessionOp::Valid { key, now: 1.0 }),
            Some(false)
        );
    }

    #[test]
    fn refuses_wrong_ports_and_keys() {
        let mut cfg = Config {
            port: 18100,
            backend_port: 39001,
            key: "a1".repeat(32),
            reply_key: "c2".repeat(32),
        };
        assert!(valid(&cfg));
        cfg.backend_port = 18100;
        assert!(!valid(&cfg));
        cfg.backend_port = 443;
        assert!(!valid(&cfg));
        cfg.backend_port = 39001;
        cfg.key = "K".repeat(64);
        assert!(!valid(&cfg));
    }
}
