//! Bounded HTTP response bodies for the private Windows dashboard's read API.
//! The Python handler has already applied authorization and selects the route.
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

const LIMIT: u64 = 8192;
const POLICY: &str = include_str!("../../../../variants.json");

#[derive(Deserialize)]
#[serde(tag = "route", deny_unknown_fields, rename_all = "snake_case")]
enum Request {
    Features {},
    Health {
        started_at: u64,
        peers: Vec<String>,
    },
    AccountStatus {
        configured: bool,
        authenticated: bool,
        auto_local: bool,
    },
}

#[derive(Serialize)]
struct AccountStatus {
    configured: bool,
    authenticated: bool,
    mode: &'static str,
    auto_local: bool,
}
#[derive(Serialize)]
struct Health {
    ok: bool,
    service: &'static str,
    started_at: u64,
    access: Access,
    peers: Vec<String>,
}
#[derive(Serialize)]
struct Access {
    enabled: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Features {
    repoql_dashboard: bool,
    tencent_connector: bool,
    kanban: bool,
    agent_chat: bool,
    office: bool,
    memory: bool,
    repoql_mcp: bool,
    kanzo: bool,
    openmausbot: bool,
    ghost: bool,
}
#[derive(Serialize)]
struct FeatureResponse<'a> {
    variant: u8,
    gui: &'a str,
    features: Features,
}

// Match the existing browser response bytes, including Python JSON separators.
struct BrowserJson;
impl serde_json::ser::Formatter for BrowserJson {
    fn begin_array_value<W: Write + ?Sized>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }
    fn begin_object_key<W: Write + ?Sized>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.begin_array_value(writer, first)
    }
    fn begin_object_value<W: Write + ?Sized>(&mut self, writer: &mut W) -> io::Result<()> {
        writer.write_all(b": ")
    }
}
fn serialize<T: Serialize>(value: T, out: impl Write) -> io::Result<()> {
    value
        .serialize(&mut serde_json::Serializer::with_formatter(
            out,
            BrowserJson,
        ))
        .map_err(io::Error::other)
}

fn respond(req: Request, out: impl Write) -> io::Result<()> {
    match req {
        Request::Features {} => {
            let policy: serde_json::Value =
                serde_json::from_str(POLICY).map_err(io::Error::other)?;
            let variant = &policy["variants"]["2"];
            let gui = variant["gui"]
                .as_str()
                .filter(|s| *s == "claude-desktop-code")
                .ok_or(io::ErrorKind::InvalidData)?;
            let features: Features =
                serde_json::from_value(variant["features"].clone()).map_err(io::Error::other)?;
            serialize(
                FeatureResponse {
                    variant: 2,
                    gui,
                    features,
                },
                out,
            )
        }
        Request::Health { started_at, peers } => {
            if peers.len() > 128
                || peers.iter().any(|p| {
                    p.len() > 80
                        || !p
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.' | b'/'))
                })
            {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            serialize(
                Health {
                    ok: true,
                    service: "repoql-dashboard",
                    started_at,
                    access: Access { enabled: false },
                    peers,
                },
                out,
            )
        }
        Request::AccountStatus {
            configured,
            authenticated,
            auto_local,
        } => serialize(
            AccountStatus {
                configured,
                authenticated,
                mode: if auto_local { "auto-local" } else { "password" },
                auto_local,
            },
            out,
        ),
    }
}

pub fn frame(raw: &[u8]) -> io::Result<Vec<u8>> {
    if raw.len() as u64 > LIMIT {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let request = serde_json::from_slice(raw).map_err(|_| io::ErrorKind::InvalidInput)?;
    let mut response = Vec::new();
    respond(request, &mut response)?;
    if response.len() as u64 > LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_status_serializes_browser_shape() {
        let mut buf = vec![];
        respond(
            Request::AccountStatus {
                configured: true,
                authenticated: false,
                auto_local: false,
            },
            &mut buf,
        )
        .unwrap();
        assert_eq!(buf, br#"{"configured": true, "authenticated": false, "mode": "password", "auto_local": false}"#);
    }
    #[test]
    fn request_rejects_credentials_and_unknown_routes() {
        for wire in [
            r#"{"route":"features","token":"fixture"}"#,
            r#"{"route":"mutation"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(wire).is_err());
        }
    }
}
