//! IMAP sessions: connecting (TLS from the start, or STARTTLS, which is
//! then required: never a login in the clear), logging in (SASL PLAIN, else
//! LOGIN; OAUTHBEARER, else XOAUTH2 with a token), naming the app (ID) and
//! turning on what the server offers (ENABLE CONDSTORE QRESYNC UTF8=ACCEPT).
//!
//! Everything after the TCP connection is generic over the stream, so
//! tests talk to a scripted server over `tokio::io::duplex`.

use std::collections::BTreeSet;
use std::fmt;
use std::ops::{Deref, DerefMut};
use std::time::Duration;

use async_imap::imap_proto::{self, Response, ResponseCode, Status};
use async_imap::types::Mailbox;
use async_imap::{Authenticator, Client, Connection, Session};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use super::account::{MailServer, Security};
use super::error::{MailServerError, ServerRole, answer_text};
use super::tls::Connector;

/// How long connecting may take: TCP, then TLS (with STARTTLS and the greeting).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long logging in may take (servers slow down failed logins).
const LOGIN_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a `NOOP` that checks a connection may take.
const PING_TIMEOUT: Duration = Duration::from_secs(15);

/// What a session talks over: TLS to a server, or anything in tests.
pub trait Transport: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug> Transport for T {}

/// The stream of a real session (TLS over TCP; tests box a duplex).
pub type Stream = Box<dyn Transport>;

/// A server's capabilities (or what ENABLE turned on), upper case:
/// `IMAP4REV1`, `AUTH=PLAIN`, `IDLE`, `CONDSTORE`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities(BTreeSet<String>);

impl Capabilities {
    /// True if the server has `name` (any case).
    pub fn has(&self, name: &str) -> bool {
        self.0.contains(&name.to_ascii_uppercase())
    }

    /// True if the server offers the SASL `mechanism` (`AUTH=<mechanism>`).
    pub fn auth(&self, mechanism: &str) -> bool {
        self.has(&format!("AUTH={mechanism}"))
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }

    fn from_proto(list: &[imap_proto::Capability<'_>]) -> Self {
        Self(
            list.iter()
                .map(|capability| match capability {
                    imap_proto::Capability::Imap4rev1 => "IMAP4REV1".to_string(),
                    imap_proto::Capability::Auth(mechanism) => {
                        format!("AUTH={}", mechanism.to_ascii_uppercase())
                    }
                    imap_proto::Capability::Atom(atom) => atom.to_ascii_uppercase(),
                })
                .collect(),
        )
    }

    fn from_session(capabilities: &async_imap::types::Capabilities) -> Self {
        use async_imap::types::Capability;
        Self(
            capabilities
                .iter()
                .map(|capability| match capability {
                    Capability::Imap4rev1 => "IMAP4REV1".to_string(),
                    Capability::Auth(mechanism) => {
                        format!("AUTH={}", mechanism.to_ascii_uppercase())
                    }
                    Capability::Atom(atom) => atom.to_ascii_uppercase(),
                })
                .collect(),
        )
    }
}

impl<'a> FromIterator<&'a str> for Capabilities {
    fn from_iter<I: IntoIterator<Item = &'a str>>(names: I) -> Self {
        Self(names.into_iter().map(str::to_ascii_uppercase).collect())
    }
}

/// How an account proves who it is.
#[derive(Clone, Copy)]
pub enum Secret<'a> {
    Password(&'a str),
    /// An OAuth access token (Yahoo, AOL).
    Bearer(&'a str),
}

/// Where and as whom to log in.
#[derive(Clone, Copy)]
pub struct Login<'a> {
    pub server: &'a MailServer,
    pub username: &'a str,
    pub secret: Secret<'a>,
}

/// How a folder is opened: `EXAMINE` or `SELECT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    ReadOnly,
    ReadWrite,
}

/// The folder a session has open.
#[derive(Clone, Debug)]
pub struct Selected {
    /// The path as the server names it (as sent in `SELECT`).
    pub path: String,
    /// Opened with `EXAMINE`.
    pub read_only: bool,
    /// What `SELECT`/`EXAMINE` said: UIDVALIDITY, UIDNEXT, EXISTS,
    /// HIGHESTMODSEQ (as of opening).
    pub mailbox: Mailbox,
}

/// A logged-in session, with what the server can do and which folder is
/// open. Derefs to async-imap's `Session` for the commands.
///
/// Whoever changes the selected folder with a raw command (`SELECT`,
/// `EXAMINE`, `CLOSE`, `UNSELECT`, a failed `SELECT`) updates [`Self::selected`]
/// (or sets it to `None`); [`Self::open_folder`] does it by itself.
pub struct ImapSession<S: Transport = Stream> {
    session: Session<S>,
    /// The capabilities after logging in.
    pub capabilities: Capabilities,
    /// What `ENABLE` turned on (`CONDSTORE`, `QRESYNC`, `UTF8=ACCEPT`).
    pub enabled: Capabilities,
    /// The folder that's open, if any.
    pub selected: Option<Selected>,
}

impl<S: Transport> fmt::Debug for ImapSession<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImapSession")
            .field("capabilities", &self.capabilities)
            .field("enabled", &self.enabled)
            .field("selected", &self.selected.as_ref().map(|s| &s.path))
            .finish()
    }
}

impl<S: Transport> Deref for ImapSession<S> {
    type Target = Session<S>;

    fn deref(&self) -> &Session<S> {
        &self.session
    }
}

impl<S: Transport> DerefMut for ImapSession<S> {
    fn deref_mut(&mut self) -> &mut Session<S> {
        &mut self.session
    }
}

impl<S: Transport> ImapSession<S> {
    /// A session from its parts (tests that start logged in).
    pub fn new(session: Session<S>, capabilities: Capabilities, enabled: Capabilities) -> Self {
        Self {
            session,
            capabilities,
            enabled,
            selected: None,
        }
    }

    /// Opens `path` unless it's open already with at least `access`
    /// (read-write covers read-only). The state is as of opening it; see
    /// [`Self::reopen_folder`] for fresh counts.
    pub async fn open_folder(
        &mut self,
        path: &str,
        access: Access,
    ) -> Result<&Selected, MailServerError> {
        let open = self.selected.as_ref().is_some_and(|selected| {
            selected.path == path && (access == Access::ReadOnly || !selected.read_only)
        });
        if open {
            return Ok(self.selected.as_ref().expect("a folder is open"));
        }
        self.reopen_folder(path, access).await
    }

    /// Opens `path` (again): `SELECT` (with `CONDSTORE` where the server has
    /// it but it isn't enabled) or `EXAMINE`.
    pub async fn reopen_folder(
        &mut self,
        path: &str,
        access: Access,
    ) -> Result<&Selected, MailServerError> {
        // A SELECT that fails leaves no folder open.
        self.selected = None;
        let mailbox = match access {
            Access::ReadWrite
                if self.capabilities.has("CONDSTORE") && !self.enabled.has("CONDSTORE") =>
            {
                self.session.select_condstore(path).await?
            }
            Access::ReadWrite => self.session.select(path).await?,
            Access::ReadOnly => self.session.examine(path).await?,
        };
        Ok(self.selected.insert(Selected {
            path: path.to_string(),
            read_only: access == Access::ReadOnly,
            mailbox,
        }))
    }

    /// `NOOP`: checks the connection (and lets the server report changes).
    pub async fn ping(&mut self) -> Result<(), MailServerError> {
        tokio::time::timeout(PING_TIMEOUT, self.session.noop()).await??;
        Ok(())
    }

    /// Logs out politely (best effort: the connection closes either way).
    pub async fn logout(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.session.logout()).await;
    }

    /// async-imap's session, for what needs it by value (IDLE).
    pub fn into_inner(self) -> Session<S> {
        self.session
    }
}

/// Opens a TCP connection to `host:port` (within [`CONNECT_TIMEOUT`]).
pub async fn tcp(host: &str, port: u16) -> Result<TcpStream, MailServerError> {
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| MailServerError::unreachable(format!("{host}:{port} didn't answer.")))?
        .map_err(|error| {
            MailServerError::unreachable(format!("Couldn't reach {host}:{port}: {error}"))
        })?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Connects to the IMAP server and logs in. TLS uses `tls` (the system's
/// checks and the account's pinned certificate).
pub async fn connect(login: &Login<'_>, tls: &Connector) -> Result<ImapSession, MailServerError> {
    let server = login.server;
    let tcp = tcp(&server.host, server.port).await?;
    let secure = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let plain = match server.security {
            Security::Tls => tcp,
            Security::Starttls => starttls(tcp).await?,
        };
        tls.handshake(&server.host, plain, ServerRole::Imap).await
    })
    .await
    .map_err(|_| {
        MailServerError::unreachable(format!(
            "{}:{} didn't answer in time. Are the port and security right?",
            server.host, server.port
        ))
    })??;
    let stream: Stream = Box::new(secure);
    tokio::time::timeout(
        LOGIN_TIMEOUT,
        login_on(stream, server.security == Security::Tls, login),
    )
    .await?
}

/// The unencrypted start of STARTTLS: the greeting, the capabilities and
/// `STARTTLS`. Returns the stream, ready for the TLS handshake. A server
/// that doesn't offer STARTTLS is refused (`tls`): no login in the clear.
pub async fn starttls<S: Transport>(stream: S) -> Result<S, MailServerError> {
    let mut client = Client::new(stream);
    let capabilities = match greeting(&mut client).await? {
        Some(capabilities) => capabilities,
        None => {
            exchange(&mut client, "p1", "CAPABILITY")
                .await?
                .capabilities
        }
    };
    if !capabilities.has("STARTTLS") {
        return Err(MailServerError::tls(
            "The IMAP server doesn't offer STARTTLS, and action0 never logs in unencrypted.",
        ));
    }
    let answer = exchange(&mut client, "p2", "STARTTLS").await?;
    if answer.status != Reply::Ok {
        return Err(MailServerError::tls(format!(
            "The IMAP server refused STARTTLS: {}",
            answer.text
        )));
    }
    // Anything the server sent after its OK is dropped with the client.
    Ok(client.into_inner())
}

/// Logs in on a secure stream: reads the greeting (if `greeting`; after
/// STARTTLS there's none), asks for the capabilities (those from before
/// STARTTLS don't count), logs in, then ID and ENABLE.
pub async fn login_on<S: Transport>(
    stream: S,
    greeting: bool,
    login: &Login<'_>,
) -> Result<ImapSession<S>, MailServerError> {
    let mut client = Client::new(stream);
    let greeted = if greeting {
        self::greeting(&mut client).await?
    } else {
        None
    };
    let capabilities = match greeted {
        Some(capabilities) => capabilities,
        None => {
            exchange(&mut client, "p1", "CAPABILITY")
                .await?
                .capabilities
        }
    };
    let mut session = authenticate(client, &capabilities, login).await?;
    let capabilities = Capabilities::from_session(&session.capabilities().await?);
    if capabilities.has("ID") {
        identify(&mut session).await?;
    }
    let enabled = enable(&mut session, &capabilities).await?;
    Ok(ImapSession::new(session, capabilities, enabled))
}

/// The end of a command.
#[derive(Debug, PartialEq, Eq)]
enum Reply {
    Ok,
    No,
    Bad,
}

/// What a command got: its end, its text, and the capabilities named on the way.
struct Answer {
    status: Reply,
    text: String,
    capabilities: Capabilities,
}

fn closed() -> MailServerError {
    MailServerError::unreachable("The IMAP server closed the connection.")
}

/// The server's greeting: OK (with its capabilities, if it names them);
/// BYE or PREAUTH are refusals.
async fn greeting<S: Transport>(
    connection: &mut Connection<S>,
) -> Result<Option<Capabilities>, MailServerError> {
    let response = connection.read_response().await?.ok_or_else(closed)?;
    match response.parsed() {
        Response::Data {
            status: Status::Ok,
            outcome,
        } => Ok(match &outcome.code {
            Some(ResponseCode::Capabilities(list)) => Some(Capabilities::from_proto(list)),
            _ => None,
        }),
        Response::Data {
            status: Status::Bye,
            outcome,
        } => Err(MailServerError::server(format!(
            "The IMAP server turned the connection away: {}",
            outcome.information.as_deref().unwrap_or_default()
        ))),
        Response::Data {
            status: Status::PreAuth,
            ..
        } => Err(MailServerError::server(
            "The IMAP server let action0 in without a login, which it doesn't support.",
        )),
        _ => Err(MailServerError::server(
            "The server didn't greet like an IMAP server. Are the port and security right?",
        )),
    }
}

/// Sends `command` with our own `tag` and reads up to its end, keeping the
/// capabilities named on the way (`CAPABILITY`, `ENABLED`, response codes).
async fn exchange<S: Transport>(
    connection: &mut Connection<S>,
    tag: &str,
    command: &str,
) -> Result<Answer, MailServerError> {
    let stream = connection.get_mut();
    stream
        .write_all(format!("{tag} {command}\r\n").as_bytes())
        .await?;
    stream.flush().await?;
    let mut capabilities = Capabilities::default();
    loop {
        let response = connection.read_response().await?.ok_or_else(closed)?;
        match response.parsed() {
            Response::Capabilities(list) => {
                capabilities.0.extend(Capabilities::from_proto(list).0);
            }
            Response::Data {
                status: Status::Bye,
                outcome,
            } => {
                return Err(MailServerError::unreachable(format!(
                    "The IMAP server closed the connection: {}",
                    outcome.information.as_deref().unwrap_or_default()
                )));
            }
            Response::Done {
                tag: done,
                status,
                outcome,
            } if done.0 == tag => {
                if let Some(ResponseCode::Capabilities(list)) = &outcome.code {
                    capabilities.0.extend(Capabilities::from_proto(list).0);
                }
                return Ok(Answer {
                    status: match status {
                        Status::Ok => Reply::Ok,
                        Status::No => Reply::No,
                        _ => Reply::Bad,
                    },
                    text: outcome
                        .information
                        .as_deref()
                        .unwrap_or_default()
                        .to_string(),
                    capabilities,
                });
            }
            _ => {}
        }
    }
}

/// A SASL exchange: an initial response (unless it went with the command),
/// then `later` to anything the server asks after it (the details of a
/// refusal, which XOAUTH2 answers with nothing and OAUTHBEARER with ^A).
struct Sasl {
    first: Option<Vec<u8>>,
    later: &'static [u8],
}

impl Authenticator for Sasl {
    type Response = Vec<u8>;

    fn process(&mut self, _challenge: &[u8]) -> Vec<u8> {
        self.first.take().unwrap_or_else(|| self.later.to_vec())
    }
}

/// Escapes a SASL GS2 name (`=` and `,`).
fn gs2_name(name: &str) -> String {
    name.replace('=', "=3D").replace(',', "=2C")
}

/// Logs in with the best way the server offers.
async fn authenticate<S: Transport>(
    client: Client<S>,
    capabilities: &Capabilities,
    login: &Login<'_>,
) -> Result<Session<S>, MailServerError> {
    let user = login.username;
    let (mechanism, initial, later) = match login.secret {
        Secret::Password(password) if capabilities.auth("PLAIN") => (
            "PLAIN",
            format!("\0{user}\0{password}").into_bytes(),
            &b""[..],
        ),
        Secret::Password(password) if !capabilities.has("LOGINDISABLED") => {
            return client
                .login(user, password)
                .await
                .map_err(|(error, _)| refused(error));
        }
        Secret::Password(_) => {
            return Err(MailServerError::server(
                "The IMAP server doesn't take passwords (no AUTH=PLAIN, and LOGINDISABLED).",
            ));
        }
        Secret::Bearer(token) if capabilities.auth("OAUTHBEARER") => (
            "OAUTHBEARER",
            format!(
                "n,a={},\x01host={}\x01port={}\x01auth=Bearer {token}\x01\x01",
                gs2_name(user),
                login.server.host,
                login.server.port
            )
            .into_bytes(),
            &b"\x01"[..],
        ),
        Secret::Bearer(token) => (
            "XOAUTH2",
            format!("user={user}\x01auth=Bearer {token}\x01\x01").into_bytes(),
            &b""[..],
        ),
    };
    // With SASL-IR the first response goes with the command (one round
    // trip less, and no "+" in between).
    let (command, sasl) = if capabilities.has("SASL-IR") {
        (
            format!("{mechanism} {}", STANDARD.encode(&initial)),
            Sasl { first: None, later },
        )
    } else {
        (
            mechanism.to_string(),
            Sasl {
                first: Some(initial),
                later,
            },
        )
    };
    client
        .authenticate(command, sasl)
        .await
        .map_err(|(error, _)| refused(error))
}

/// What a refused login means: NO is the password (unless the server says
/// it's unavailable for now), BAD a server that didn't understand.
fn refused(error: async_imap::error::Error) -> MailServerError {
    use async_imap::error::Error;
    match error {
        Error::No(detail) => {
            let (code, text) = answer_text(&detail);
            match code.as_deref() {
                Some("UNAVAILABLE") => MailServerError::server(text),
                _ if text.is_empty() => MailServerError::auth("The IMAP server refused the login."),
                _ => MailServerError::auth(text),
            }
        }
        Error::Bad(detail) => MailServerError::server(answer_text(&detail).1),
        other => other.into(),
    }
}

/// `ID`: tells the server which app this is. Its refusal doesn't matter.
async fn identify<S: Transport>(session: &mut Session<S>) -> Result<(), MailServerError> {
    use async_imap::error::Error;
    match session
        .id([
            ("name", Some("action0")),
            ("version", Some(env!("CARGO_PKG_VERSION"))),
        ])
        .await
    {
        Ok(_) | Err(Error::No(_) | Error::Bad(_) | Error::Parse(_)) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// `ENABLE`s what the server offers of CONDSTORE, QRESYNC and UTF8=ACCEPT;
/// what it turned on (QRESYNC turns on CONDSTORE too).
async fn enable<S: Transport>(
    session: &mut Session<S>,
    capabilities: &Capabilities,
) -> Result<Capabilities, MailServerError> {
    let wanted: Vec<&str> = ["CONDSTORE", "QRESYNC", "UTF8=ACCEPT"]
        .into_iter()
        .filter(|name| capabilities.has(name))
        .collect();
    if wanted.is_empty() || !(capabilities.has("ENABLE") || capabilities.has("IMAP4REV2")) {
        return Ok(Capabilities::default());
    }
    let answer = exchange(session, "e1", &format!("ENABLE {}", wanted.join(" "))).await?;
    if answer.status != Reply::Ok {
        return Ok(Capabilities::default());
    }
    let mut enabled = answer.capabilities;
    if enabled.has("QRESYNC") {
        enabled.0.insert("CONDSTORE".into());
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::error::ErrorKind;
    use crate::imap::testing::{self, TestCa, scripted};

    fn server() -> MailServer {
        MailServer {
            host: "imap.example.org".into(),
            port: 993,
            security: Security::Tls,
        }
    }

    fn password(server: &MailServer) -> Login<'_> {
        Login {
            server,
            username: "user",
            secret: Secret::Password("pass"),
        }
    }

    /// "\0user\0pass" in base64.
    const PLAIN: &str = "AHVzZXIAcGFzcw==";

    #[tokio::test]
    async fn logs_in_with_sasl_plain_then_names_itself_and_enables() {
        let (stream, script) = scripted(&format!(
            "
            S: * OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=LOGIN] Dovecot ready.
            C: A0001 AUTHENTICATE PLAIN {PLAIN}
            S: A0001 OK Logged in
            C: A0002 CAPABILITY
            S: * CAPABILITY IMAP4rev1 ID ENABLE IDLE MOVE CONDSTORE QRESYNC UTF8=ACCEPT
            S: A0002 OK Capability completed.
            C: A0003 ID (\"name\" \"action0\" \"version\" \"{}\")
            S: * ID (\"name\" \"Dovecot\")
            S: A0003 OK ID completed.
            C: e1 ENABLE CONDSTORE QRESYNC UTF8=ACCEPT
            S: * ENABLED QRESYNC UTF8=ACCEPT
            S: e1 OK Enabled.
            ",
            env!("CARGO_PKG_VERSION")
        ));
        let server = server();
        let session = login_on(stream, true, &password(&server)).await.unwrap();
        script.await.unwrap().unwrap();
        assert!(session.capabilities.has("idle"));
        assert!(session.capabilities.has("IMAP4rev1"));
        assert!(!session.capabilities.auth("PLAIN"));
        assert!(session.enabled.has("QRESYNC"));
        assert!(session.enabled.has("CONDSTORE"));
        assert!(session.enabled.has("UTF8=ACCEPT"));
        assert!(session.selected.is_none());
    }

    #[tokio::test]
    async fn asks_for_capabilities_and_uses_login_without_sasl_plain() {
        let (stream, script) = scripted(
            "
            S: * OK ready
            C: p1 CAPABILITY
            S: * CAPABILITY IMAP4rev1 AUTH=CRAM-MD5
            S: p1 OK done
            C: A0001 LOGIN \"user\" \"pass\"
            S: A0001 OK [CAPABILITY IMAP4rev1 IDLE] Logged in
            C: A0002 CAPABILITY
            S: * CAPABILITY IMAP4rev1 IDLE
            S: A0002 OK done
            ",
        );
        let server = server();
        let session = login_on(stream, true, &password(&server)).await.unwrap();
        script.await.unwrap().unwrap();
        assert!(session.capabilities.has("IDLE"));
        assert_eq!(session.enabled, Capabilities::default());
    }

    #[tokio::test]
    async fn sends_plain_after_the_servers_go_ahead_without_sasl_ir() {
        let (stream, script) = scripted(&format!(
            "
            C: p1 CAPABILITY
            S: * CAPABILITY IMAP4rev1 AUTH=PLAIN
            S: p1 OK done
            C: A0001 AUTHENTICATE PLAIN
            S: +
            C: {PLAIN}
            S: A0001 OK Logged in
            C: A0002 CAPABILITY
            S: * CAPABILITY IMAP4rev1
            S: A0002 OK done
            "
        ));
        let server = server();
        // After STARTTLS: no greeting.
        login_on(stream, false, &password(&server)).await.unwrap();
        script.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_password_is_auth_with_the_servers_text() {
        let (stream, script) = scripted(&format!(
            "
            S: * OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] ready
            C: A0001 AUTHENTICATE PLAIN {PLAIN}
            S: A0001 NO [AUTHENTICATIONFAILED] Authentication failed.
            "
        ));
        let server = server();
        let error = login_on(stream, true, &password(&server))
            .await
            .unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
        assert_eq!(error.message, "Authentication failed.");
    }

    #[tokio::test]
    async fn a_login_unavailable_for_now_is_no_password_problem() {
        let (stream, script) = scripted(
            "
            S: * OK [CAPABILITY IMAP4rev1] ready
            C: A0001 LOGIN \"user\" \"pass\"
            S: A0001 NO [UNAVAILABLE] Try again later.
            ",
        );
        let server = server();
        let error = login_on(stream, true, &password(&server))
            .await
            .unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Server);
        assert_eq!(error.message, "Try again later.");
    }

    #[tokio::test]
    async fn refuses_to_log_in_where_logins_are_disabled() {
        let (stream, script) = scripted("S: * OK [CAPABILITY IMAP4rev1 LOGINDISABLED] ready");
        let server = server();
        let error = login_on(stream, true, &password(&server))
            .await
            .unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Server);
    }

    #[tokio::test]
    async fn signs_in_with_xoauth2_and_answers_its_refusal() {
        let initial = STANDARD.encode("user=max@yahoo.com\x01auth=Bearer tok\x01\x01");
        let (stream, script) = scripted(&format!(
            "
            S: * OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 AUTH=PLAIN] ready
            C: A0001 AUTHENTICATE XOAUTH2 {initial}
            S: + eyJzdGF0dXMiOiI0MDAiLCJzY2hlbWVzIjoiQmVhcmVyIn0=
            C:
            S: A0001 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)
            "
        ));
        let server = server();
        let login = Login {
            server: &server,
            username: "max@yahoo.com",
            secret: Secret::Bearer("tok"),
        };
        let error = login_on(stream, true, &login).await.unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
        assert_eq!(error.message, "Invalid credentials (Failure)");
    }

    #[tokio::test]
    async fn prefers_oauthbearer() {
        let initial = STANDARD.encode(
            "n,a=max=2Cx@aol.com,\x01host=imap.example.org\x01port=993\x01auth=Bearer tok\x01\x01",
        );
        let (stream, script) = scripted(&format!(
            "
            S: * OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2 AUTH=OAUTHBEARER] ready
            C: A0001 AUTHENTICATE OAUTHBEARER
            S: +
            C: {initial}
            S: + eyJzdGF0dXMiOiJpbnZhbGlkX3Rva2VuIn0=
            C: AQ==
            S: A0001 NO Sign-in refused
            "
        ));
        let server = server();
        let login = Login {
            server: &server,
            username: "max,x@aol.com",
            secret: Secret::Bearer("tok"),
        };
        let error = login_on(stream, true, &login).await.unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
    }

    #[tokio::test]
    async fn a_greeting_bye_is_a_refusal() {
        let (stream, script) = scripted("S: * BYE Too many connections from your IP");
        let server = server();
        let error = login_on(stream, true, &password(&server))
            .await
            .unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Server);
        assert!(error.message.contains("Too many connections"));
    }

    #[tokio::test]
    async fn a_dropped_connection_is_unreachable() {
        let (stream, script) = scripted(
            "
            S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready
            C: A0001 AUTHENTICATE PLAIN
            ",
        );
        let server = server();
        let error = login_on(stream, true, &password(&server))
            .await
            .unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Unreachable);
    }

    #[tokio::test]
    async fn requires_starttls() {
        let (stream, script) = scripted("S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready");
        let error = starttls(stream).await.unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Tls);

        let (stream, script) = scripted(
            "
            S: * OK ready
            C: p1 CAPABILITY
            S: * CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED
            S: p1 OK done
            C: p2 STARTTLS
            S: p2 NO TLS is broken today
            ",
        );
        let error = starttls(stream).await.unwrap_err();
        script.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Tls);
        assert!(error.message.contains("TLS is broken today"));
    }

    #[tokio::test]
    async fn opens_a_folder_once() {
        let (stream, script) = scripted(
            "
            S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready
            C: A0001 AUTHENTICATE PLAIN AHVzZXIAcGFzcw==
            S: A0001 OK in
            C: A0002 CAPABILITY
            S: * CAPABILITY IMAP4rev1
            S: A0002 OK done
            C: A0003 EXAMINE \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 7] UIDs valid
            S: * OK [UIDNEXT 42] next
            S: A0003 OK [READ-ONLY] Examined
            C: A0004 SELECT \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 7] UIDs valid
            S: A0004 OK [READ-WRITE] Selected
            C: A0005 SELECT \"Archive\"
            S: A0005 NO [NONEXISTENT] No such folder
            ",
        );
        let server = server();
        let mut session = login_on(stream, true, &password(&server)).await.unwrap();
        let selected = session
            .open_folder("INBOX", Access::ReadOnly)
            .await
            .unwrap();
        assert_eq!(selected.mailbox.uid_validity, Some(7));
        assert_eq!(selected.mailbox.uid_next, Some(42));
        assert!(selected.read_only);
        // Open already: no command.
        session
            .open_folder("INBOX", Access::ReadOnly)
            .await
            .unwrap();
        // Read-write needs a SELECT, which then covers read-only.
        session
            .open_folder("INBOX", Access::ReadWrite)
            .await
            .unwrap();
        session
            .open_folder("INBOX", Access::ReadOnly)
            .await
            .unwrap();
        let error = session
            .open_folder("Archive", Access::ReadWrite)
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound, "{error:?}");
        assert!(session.selected.is_none());
        drop(session);
        script.await.unwrap().unwrap();
    }

    /// The whole way over TCP: STARTTLS, the handshake (the capabilities
    /// from before it don't count), the login.
    #[tokio::test]
    async fn connects_with_starttls_over_tcp() {
        let ca = TestCa::new();
        let acceptor = testing::acceptor(ca.issue("localhost"));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut plain, _) = listener.accept().await.unwrap();
            testing::play(
                &mut plain,
                "
                S: * OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready
                C: p2 STARTTLS
                S: p2 OK Begin TLS negotiation now
                ",
            )
            .await?;
            let mut secure = acceptor.accept(plain).await.map_err(|e| e.to_string())?;
            testing::play(
                &mut secure,
                &format!(
                    "
                    C: p1 CAPABILITY
                    S: * CAPABILITY IMAP4rev1 AUTH=PLAIN
                    S: p1 OK done
                    C: A0001 AUTHENTICATE PLAIN
                    S: +
                    C: {PLAIN}
                    S: A0001 OK in
                    C: A0002 CAPABILITY
                    S: * CAPABILITY IMAP4rev1 IDLE
                    S: A0002 OK done
                    "
                ),
            )
            .await
        });
        let imap = MailServer {
            host: "localhost".into(),
            port,
            security: Security::Starttls,
        };
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        let session = connect(&password(&imap), &tls).await.unwrap();
        assert!(session.capabilities.has("IDLE"));
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn refuses_a_certificate_for_another_name() {
        let ca = TestCa::new();
        let acceptor = testing::acceptor(ca.issue("localhost"));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (plain, _) = listener.accept().await.unwrap();
            acceptor.accept(plain).await.map(|_| ())
        });
        let imap = MailServer {
            host: "127.0.0.1".into(),
            port,
            security: Security::Tls,
        };
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        let error = connect(&password(&imap), &tls).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Untrusted);
        assert_eq!(error.server, Some(ServerRole::Imap));
        assert_eq!(error.certificate.unwrap().names, ["localhost"]);
        let _ = server.await;
    }

    #[tokio::test]
    async fn unreachable_servers_are_unreachable() {
        // A port nobody listens on.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let imap = MailServer {
            host: "127.0.0.1".into(),
            port,
            security: Security::Tls,
        };
        let tls = Connector::with_verifier(TestCa::new().verifier(), None).unwrap();
        let error = connect(&password(&imap), &tls).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Unreachable);
    }
}
