//! Filters on mail server accounts: a small ManageSieve client (RFC 5804)
//! and the `sieve_*` commands of `src/providers/sieve/bridge.ts`. Reading
//! and writing Sieve happens in the UI; this side finds the account's filter
//! server, logs in with the account's login (the UI never sees it) and its
//! pinned certificate, and moves the active script back and forth.
//!
//! - Connecting: the server's capabilities, then STARTTLS, which is
//!   required (never a login in the clear), then the capabilities again.
//! - Logging in: SASL PLAIN with a password; OAUTHBEARER, else XOAUTH2 with
//!   a Yahoo/AOL token (renewed once if it's refused, like IMAP's).
//! - Finding the server: the one kept with the account, else a provider's
//!   known one (some are known to have none and say so at once), else the
//!   IMAP host on port 4190. One that's found is kept with its extensions,
//!   so the UI can know it without connecting.
//! - Writing: the active script is read first and must still be the one the
//!   UI changed (`changed` otherwise); then PUTSCRIPT, and SETACTIVE for a
//!   new one. ManageSieve has no transactions, so this is as close as it gets.

use std::collections::BTreeSet;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::account::{ImapAccount, SieveServer};
use super::discover::{address_domain, registrable};
use super::error::{ErrorKind, MailServerError, ServerRole};
use super::session::{CONNECT_TIMEOUT, Secret, Stream, Transport, tcp};
use super::smtp::gs2_name;
use super::tls::Connector;
use super::{Credential, Imap, is_oauth};

/// The ManageSieve port.
pub const PORT: u16 = 4190;
/// How long an answer may take.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
/// The longest line read (scripts and long texts come as literals).
const LINE_LIMIT: u64 = 8 * 1024;
/// The longest literal read: far beyond any filter script.
const LITERAL_LIMIT: usize = 4 * 1024 * 1024;
/// The longest name or text sent as a quoted string (longer: a literal).
const QUOTED_LIMIT: usize = 1024;

/// Where a filter server is, as the UI enters it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct SieveAddress {
    pub host: String,
    pub port: u16,
}

/// The active script, as `sieve_read` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SieveScript {
    /// Its name; none when no script is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Its text ("" when no script is active).
    pub script: String,
    pub extensions: Vec<String>,
}

/// What `sieve_write` stores.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SieveWrite {
    pub name: String,
    pub script: String,
    /// The text the change was made from: written only if it's still there.
    pub expected: String,
    /// Make it the active script.
    pub activate: bool,
}

/// What's known about a provider's filter server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Known {
    /// It's on this host, at [`PORT`].
    At(&'static str),
    /// The provider offers none to mail programs (its name).
    Nowhere(&'static str),
}

/// A provider's filter server, by a host or domain of it.
fn known(host: &str) -> Option<Known> {
    let registrable = registrable(host);
    let brand = registrable.split('.').next().unwrap_or_default();
    Some(match (brand, registrable.as_str()) {
        (_, "mailbox.org") => Known::At("imap.mailbox.org"),
        ("posteo", _) => Known::At("posteo.de"),
        (_, "gmail.com" | "googlemail.com") => Known::Nowhere("Gmail"),
        ("outlook" | "hotmail" | "live" | "msn" | "office365", _) => Known::Nowhere("Outlook"),
        ("yahoo" | "ymail" | "rocketmail", _) => Known::Nowhere("Yahoo"),
        (_, "aol.com") => Known::Nowhere("AOL"),
        (_, "icloud.com" | "me.com" | "mac.com") => Known::Nowhere("iCloud"),
        ("gmx", _) => Known::Nowhere("GMX"),
        (_, "web.de") => Known::Nowhere("WEB.DE"),
        ("fastmail" | "messagingengine", _) => Known::Nowhere("Fastmail"),
        ("zoho" | "zohomail", _) => Known::Nowhere("Zoho Mail"),
        _ => return None,
    })
}

/// Where to look for an account's filter server: the provider's known
/// one (by its IMAP host, else its address), else the IMAP host.
fn place_of(account: &ImapAccount) -> Result<String, MailServerError> {
    let found = known(&account.settings.imap.host)
        .or_else(|| address_domain(&account.address).as_deref().and_then(known));
    match found {
        Some(Known::At(host)) => Ok(host.to_string()),
        Some(Known::Nowhere(name)) => Err(MailServerError::not_found(format!(
            "{name} offers no filters to mail programs."
        ))
        .on(ServerRole::Sieve)),
        None => Ok(account.settings.imap.host.clone()),
    }
}

impl Imap {
    /// The account's filter server: the kept one, else one found (and kept).
    pub async fn find_sieve(&self, key: &str) -> Result<SieveServer, MailServerError> {
        let account = self.account(key)?;
        if let Some(server) = account.sieve.clone() {
            return Ok(server);
        }
        let host = place_of(&account)?;
        let client = match self.sieve_session(key, &account, &host, PORT).await {
            Ok(client) => client,
            Err(error) if error.kind == ErrorKind::Unreachable => {
                return Err(MailServerError::not_found(format!(
                    "No filter server answered at {host}:{PORT}."
                ))
                .on(ServerRole::Sieve));
            }
            Err(error) => return Err(error),
        };
        let server = SieveServer {
            host,
            port: PORT,
            extensions: client.capabilities.sieve.clone(),
            chosen: false,
        };
        client.logout().await;
        self.update(key, |account| account.sieve = Some(server.clone()))?;
        Ok(server)
    }

    /// Uses `address` as the filter server from now on (after logging in
    /// there), or (`None`) forgets the kept one.
    pub async fn set_sieve_server(
        &self,
        key: &str,
        address: Option<SieveAddress>,
    ) -> Result<Option<SieveServer>, MailServerError> {
        let Some(address) = address else {
            self.update(key, |account| account.sieve = None)?;
            return Ok(None);
        };
        let host = address.host.trim().to_string();
        if host.is_empty() || address.port == 0 {
            return Err(
                MailServerError::unreachable("A server name or port is missing.")
                    .on(ServerRole::Sieve),
            );
        }
        let account = self.account(key)?;
        let client = self
            .sieve_session(key, &account, &host, address.port)
            .await?;
        let server = SieveServer {
            host,
            port: address.port,
            extensions: client.capabilities.sieve.clone(),
            chosen: true,
        };
        client.logout().await;
        self.update(key, |account| account.sieve = Some(server.clone()))?;
        Ok(Some(server))
    }

    /// The active script (found and kept the server first, if needed).
    pub async fn read_sieve(&self, key: &str) -> Result<SieveScript, MailServerError> {
        let mut client = self.open_sieve(key).await?;
        let active = client.active_script().await;
        let extensions = client.capabilities.sieve.clone();
        client.logout().await;
        let (name, script) = match active? {
            Some((name, script)) => (Some(name), script),
            None => (None, String::new()),
        };
        Ok(SieveScript {
            name,
            script,
            extensions,
        })
    }

    /// Stores a script, if the active one is still `request.expected`.
    pub async fn write_sieve(
        &self,
        key: &str,
        request: &SieveWrite,
    ) -> Result<(), MailServerError> {
        let mut client = self.open_sieve(key).await?;
        let written = write(&mut client, request).await;
        client.logout().await;
        written
    }

    /// A logged-in session with the account's filter server, whose kept
    /// extensions are brought up to date.
    async fn open_sieve(&self, key: &str) -> Result<SieveClient<Stream>, MailServerError> {
        let server = self.find_sieve(key).await?;
        let account = self.account(key)?;
        let client = self
            .sieve_session(key, &account, &server.host, server.port)
            .await?;
        if client.capabilities.sieve != server.extensions {
            let extensions = client.capabilities.sieve.clone();
            self.update(key, |account| {
                if let Some(kept) = &mut account.sieve {
                    kept.extensions = extensions;
                }
            })?;
        }
        Ok(client)
    }

    /// Logs in at `host:port` as the account; a Yahoo/AOL token that's
    /// refused is renewed once.
    async fn sieve_session(
        &self,
        key: &str,
        account: &ImapAccount,
        host: &str,
        port: u16,
    ) -> Result<SieveClient<Stream>, MailServerError> {
        let (credential, renewed) = self.credential(key, false).await?;
        let open = |credential: Credential| async move {
            let tls = Connector::new(account.pinned.as_deref())?;
            connect(
                host,
                port,
                &tls,
                &account.settings.username,
                credential.secret(),
            )
            .await
        };
        match open(credential).await {
            Err(error) if error.kind == ErrorKind::Auth && !renewed && is_oauth(account) => {
                let (credential, _) = self.credential(key, true).await?;
                open(credential).await
            }
            result => result,
        }
    }
}

/// Writes `request` if the active script is still what it was made from.
async fn write<S: AsyncRead + AsyncWrite + Unpin>(
    client: &mut SieveClient<S>,
    request: &SieveWrite,
) -> Result<(), MailServerError> {
    let active = client.active_script().await?;
    let current = active.as_ref().map_or("", |(_, script)| script.as_str());
    if same_text(current) != same_text(&request.expected) {
        return Err(MailServerError::new(
            ErrorKind::Changed,
            "The filters were changed somewhere else meanwhile.",
        )
        .on(ServerRole::Sieve));
    }
    client.put_script(&request.name, &request.script).await?;
    if request.activate {
        client.set_active(&request.name).await?;
    }
    Ok(())
}

/// The text with CRLF as LF, for comparing scripts (servers may store
/// either).
fn same_text(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// Connects to a filter server (STARTTLS, which is required) and logs in.
pub async fn connect(
    host: &str,
    port: u16,
    tls: &Connector,
    username: &str,
    secret: Secret<'_>,
) -> Result<SieveClient<Stream>, MailServerError> {
    let plain = tcp(host, port)
        .await
        .map_err(|error| error.on(ServerRole::Sieve))?;
    let client = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let plain = starttls(plain).await?;
        let secure = tls.handshake(host, plain, ServerRole::Sieve).await?;
        SieveClient::start(Box::new(secure) as Stream).await
    })
    .await
    .map_err(|_| {
        MailServerError::unreachable(format!(
            "{host}:{port} didn't answer in time. Is it a filter server?"
        ))
    })
    .and_then(|started| started);
    let mut client = client.map_err(|error| error.on(ServerRole::Sieve))?;
    client.authenticate(username, secret).await?;
    Ok(client)
}

/// The unencrypted start: the capabilities and `STARTTLS`. The stream,
/// ready for the TLS handshake; a server without STARTTLS is refused (`tls`).
pub async fn starttls<S: Transport>(stream: S) -> Result<S, MailServerError> {
    let mut client = SieveClient::start(stream).await?;
    if !client.capabilities.starttls {
        return Err(MailServerError::tls(
            "The filter server doesn't offer STARTTLS, and action0 never logs in unencrypted.",
        ));
    }
    let response = client.command(b"STARTTLS\r\n").await?.1;
    if response.status != Status::Ok {
        return Err(MailServerError::tls(format!(
            "The filter server refused STARTTLS: {}",
            response.text
        )));
    }
    // Anything sent after the OK would be an injection: refuse it.
    if !client.io.buffer().is_empty() {
        return Err(MailServerError::tls(
            "The filter server sent more than it should before TLS.",
        ));
    }
    Ok(client.io.into_inner())
}

/// What the server says it can do.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    /// SASL mechanisms, upper case.
    sasl: BTreeSet<String>,
    /// Sieve extensions, lower case.
    pub sieve: Vec<String>,
    starttls: bool,
}

impl Capabilities {
    fn sasl(&self, mechanism: &str) -> bool {
        self.sasl.contains(mechanism)
    }

    /// From the capability lines (`"NAME" ["value"]` each).
    fn parse(lines: &[Vec<Token>]) -> Self {
        let mut capabilities = Self::default();
        for line in lines {
            let (Some(Token::Text(name)), value) = (line.first(), line.get(1)) else {
                continue;
            };
            let value = match value {
                Some(Token::Text(value)) => value.as_str(),
                _ => "",
            };
            match name.to_ascii_uppercase().as_str() {
                "SASL" => {
                    capabilities.sasl = value
                        .split_whitespace()
                        .map(str::to_ascii_uppercase)
                        .collect()
                }
                "SIEVE" => {
                    capabilities.sieve = value
                        .split_whitespace()
                        .map(str::to_ascii_lowercase)
                        .collect()
                }
                "STARTTLS" => capabilities.starttls = true,
                _ => {}
            }
        }
        capabilities
    }
}

/// A piece of a server line.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Atom(String),
    /// A quoted string or a literal.
    Text(String),
    Open,
    Close,
}

/// How a command ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Ok,
    No,
    Bye,
}

/// A command's result: `OK`, `NO` or `BYE`, its response code (the first
/// word, upper case: `AUTH-TOO-WEAK`, `QUOTA/MAXSIZE`, …) and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Response {
    status: Status,
    code: Option<String>,
    text: String,
}

impl Response {
    /// The line as a result, if it is one.
    fn of(tokens: &[Token]) -> Option<Self> {
        let Some(Token::Atom(first)) = tokens.first() else {
            return None;
        };
        let status = match first.to_ascii_uppercase().as_str() {
            "OK" => Status::Ok,
            "NO" => Status::No,
            "BYE" => Status::Bye,
            _ => return None,
        };
        let mut rest = &tokens[1..];
        let mut code = None;
        if rest.first() == Some(&Token::Open) {
            let end = rest
                .iter()
                .position(|token| *token == Token::Close)
                .unwrap_or(rest.len());
            code = match rest.get(1) {
                Some(Token::Atom(word)) => Some(word.to_ascii_uppercase()),
                _ => None,
            };
            rest = rest.get(end + 1..).unwrap_or_default();
        }
        let text = rest
            .iter()
            .find_map(|token| match token {
                Token::Text(text) => Some(text.trim().to_string()),
                _ => None,
            })
            .unwrap_or_default();
        Some(Self { status, code, text })
    }
}

/// What a refused step was.
#[derive(Clone, Copy, Debug)]
enum Step {
    Login,
    Read,
    Write,
}

/// What a `NO` or `BYE` means for the UI.
fn refusal(response: &Response, step: Step) -> MailServerError {
    let code = response.code.as_deref().unwrap_or_default();
    let kind = match (response.status, step) {
        (Status::Bye, _) => ErrorKind::Unreachable,
        _ if code == "ENCRYPT-NEEDED" => ErrorKind::Tls,
        _ if code == "TRYLATER" => ErrorKind::Server,
        (_, Step::Login) => ErrorKind::Auth,
        _ if code == "NONEXISTENT" => ErrorKind::NotFound,
        (_, Step::Write) => ErrorKind::Rejected,
        _ => ErrorKind::Server,
    };
    let message = if response.text.is_empty() {
        match (response.status, step) {
            (Status::Bye, _) => "The filter server closed the connection.",
            (_, Step::Login) => "The filter server refused the login.",
            (_, Step::Write) => "The filter server refused the filters.",
            _ => "The filter server refused.",
        }
        .to_string()
    } else {
        response.text.clone()
    };
    MailServerError::new(kind, message).on(ServerRole::Sieve)
}

/// Fails with the refusal unless the result is `OK`.
fn ok(response: Response, step: Step) -> Result<(), MailServerError> {
    match response.status {
        Status::Ok => Ok(()),
        _ => Err(refusal(&response, step)),
    }
}

/// One server line as tokens; the length of the literal that ends it, if
/// one does (`{n}`; the client's `{n+}` is read too).
fn tokenize(line: &[u8], tokens: &mut Vec<Token>) -> Result<Option<usize>, MailServerError> {
    let bad = || {
        MailServerError::server(format!(
            "Not a filter server answer: {:.80}",
            String::from_utf8_lossy(line)
        ))
    };
    let mut i = 0;
    while i < line.len() {
        match line[i] {
            b' ' | b'\t' => i += 1,
            b'(' => {
                tokens.push(Token::Open);
                i += 1;
            }
            b')' => {
                tokens.push(Token::Close);
                i += 1;
            }
            b'"' => {
                let mut text = Vec::new();
                i += 1;
                loop {
                    match line.get(i) {
                        None => return Err(bad()),
                        Some(b'"') => break,
                        Some(b'\\') => {
                            text.push(*line.get(i + 1).ok_or_else(bad)?);
                            i += 1;
                        }
                        Some(&byte) => text.push(byte),
                    }
                    i += 1;
                }
                i += 1;
                tokens.push(Token::Text(String::from_utf8_lossy(&text).into_owned()));
            }
            b'{' => {
                let inner = line[i + 1..].strip_suffix(b"}").ok_or_else(bad)?;
                let digits = inner.strip_suffix(b"+").unwrap_or(inner);
                let length = std::str::from_utf8(digits)
                    .ok()
                    .filter(|digits| {
                        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                    })
                    .and_then(|digits| digits.parse::<usize>().ok())
                    .ok_or_else(bad)?;
                return Ok(Some(length));
            }
            _ => {
                let start = i;
                while i < line.len() && !matches!(line[i], b' ' | b'\t' | b'(' | b')') {
                    i += 1;
                }
                tokens.push(Token::Atom(
                    String::from_utf8_lossy(&line[start..i]).into_owned(),
                ));
            }
        }
    }
    Ok(None)
}

/// `text` as a quoted string, or as a literal when it can't be one.
fn push_string(out: &mut Vec<u8>, text: &str) {
    if text.len() > QUOTED_LIMIT || text.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0)) {
        push_literal(out, text);
        return;
    }
    out.push(b'"');
    for byte in text.bytes() {
        if byte == b'"' || byte == b'\\' {
            out.push(b'\\');
        }
        out.push(byte);
    }
    out.push(b'"');
}

/// `text` as a literal the server doesn't confirm first (`{n+}`).
fn push_literal(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(format!("{{{}+}}\r\n", text.len()).as_bytes());
    out.extend_from_slice(text.as_bytes());
}

/// A conversation with a filter server.
pub struct SieveClient<S> {
    io: BufReader<S>,
    pub capabilities: Capabilities,
}

impl<S: AsyncRead + AsyncWrite + Unpin> SieveClient<S> {
    /// Reads the capabilities the server sends on connecting (and again
    /// after STARTTLS) up to its `OK`.
    async fn start(stream: S) -> Result<Self, MailServerError> {
        let mut client = Self {
            io: BufReader::new(stream),
            capabilities: Capabilities::default(),
        };
        let mut lines = Vec::new();
        loop {
            let tokens = client.line().await?;
            if let Some(response) = Response::of(&tokens) {
                if response.status != Status::Ok {
                    return Err(MailServerError::server(format!(
                        "The filter server turned the connection away: {}",
                        response.text
                    )));
                }
                client.capabilities = Capabilities::parse(&lines);
                return Ok(client);
            }
            // Capabilities are strings; anything else isn't ManageSieve.
            if !matches!(tokens.first(), Some(Token::Text(_))) || lines.len() > 100 {
                return Err(MailServerError::not_found(
                    "There's no filter server (ManageSieve) there.",
                ));
            }
            lines.push(tokens);
        }
    }

    /// One server line (with the literals in it) as tokens.
    async fn line(&mut self) -> Result<Vec<Token>, MailServerError> {
        tokio::time::timeout(REPLY_TIMEOUT, async {
            let mut tokens = Vec::new();
            loop {
                let mut line = Vec::new();
                (&mut self.io)
                    .take(LINE_LIMIT)
                    .read_until(b'\n', &mut line)
                    .await?;
                if line.last() != Some(&b'\n') {
                    return Err(if line.len() as u64 >= LINE_LIMIT {
                        MailServerError::server("The filter server sent a line that's too long.")
                    } else {
                        MailServerError::unreachable("The filter server closed the connection.")
                    });
                }
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let Some(length) = tokenize(&line, &mut tokens)? else {
                    return Ok(tokens);
                };
                if length > LITERAL_LIMIT {
                    return Err(MailServerError::server(
                        "The filter server sent more than a script can have.",
                    ));
                }
                let mut bytes = vec![0; length];
                self.io.read_exact(&mut bytes).await?;
                tokens.push(Token::Text(String::from_utf8_lossy(&bytes).into_owned()));
                // The line goes on after the literal.
            }
        })
        .await?
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), MailServerError> {
        tokio::time::timeout(REPLY_TIMEOUT, async {
            let stream = self.io.get_mut();
            stream.write_all(bytes).await?;
            stream.flush().await?;
            Ok(())
        })
        .await?
    }

    /// Sends a command (with its CRLF) and reads lines up to its result:
    /// the lines before it, and the result.
    async fn command(
        &mut self,
        command: &[u8],
    ) -> Result<(Vec<Vec<Token>>, Response), MailServerError> {
        self.write(command).await?;
        let mut lines = Vec::new();
        loop {
            let tokens = self.line().await?;
            if let Some(response) = Response::of(&tokens) {
                return Ok((lines, response));
            }
            if lines.len() > 10_000 {
                return Err(MailServerError::server(
                    "The filter server sent too many lines.",
                ));
            }
            lines.push(tokens);
        }
    }

    /// Logs in the best way the server offers.
    async fn authenticate(
        &mut self,
        username: &str,
        secret: Secret<'_>,
    ) -> Result<(), MailServerError> {
        let (mechanism, initial, answer) = match secret {
            Secret::Password(password) if self.capabilities.sasl("PLAIN") => {
                ("PLAIN", format!("\0{username}\0{password}"), "*")
            }
            Secret::Password(_) => {
                return Err(MailServerError::server(
                    "The filter server offers no password login (SASL PLAIN).",
                )
                .on(ServerRole::Sieve));
            }
            Secret::Bearer(token) if self.capabilities.sasl("OAUTHBEARER") => (
                "OAUTHBEARER",
                format!("n,a={},\x01auth=Bearer {token}\x01\x01", gs2_name(username)),
                "AQ==",
            ),
            Secret::Bearer(token) if self.capabilities.sasl("XOAUTH2") => (
                "XOAUTH2",
                format!("user={username}\x01auth=Bearer {token}\x01\x01"),
                "",
            ),
            Secret::Bearer(_) => {
                return Err(MailServerError::server(
                    "The filter server offers no sign-in with a token (OAUTHBEARER or XOAUTH2).",
                )
                .on(ServerRole::Sieve));
            }
        };
        let mut command = format!("AUTHENTICATE \"{mechanism}\" ").into_bytes();
        push_string(&mut command, &STANDARD.encode(initial));
        command.extend_from_slice(b"\r\n");
        self.write(&command).await?;
        let mut tokens = self.line().await?;
        // A challenge (a refused token's details): answer it, or cancel
        // ("*") where there's nothing to say, and read the result.
        if Response::of(&tokens).is_none() {
            self.write(format!("\"{answer}\"\r\n").as_bytes()).await?;
            tokens = self.line().await?;
        }
        let response = Response::of(&tokens).ok_or_else(|| {
            MailServerError::server("The filter server didn't finish the login.")
                .on(ServerRole::Sieve)
        })?;
        ok(response, Step::Login)
    }

    /// The active script's name and text, if one is active.
    async fn active_script(&mut self) -> Result<Option<(String, String)>, MailServerError> {
        let (lines, response) = self.command(b"LISTSCRIPTS\r\n").await?;
        ok(response, Step::Read)?;
        let active = lines.into_iter().find_map(|line| match line.as_slice() {
            [Token::Text(name), Token::Atom(word)] if word.eq_ignore_ascii_case("ACTIVE") => {
                Some(name.clone())
            }
            _ => None,
        });
        let Some(name) = active else {
            return Ok(None);
        };
        let script = self.get_script(&name).await?;
        Ok(Some((name, script)))
    }

    /// A script's text.
    async fn get_script(&mut self, name: &str) -> Result<String, MailServerError> {
        let mut command = b"GETSCRIPT ".to_vec();
        push_string(&mut command, name);
        command.extend_from_slice(b"\r\n");
        let (lines, response) = self.command(&command).await?;
        ok(response, Step::Read)?;
        match lines.as_slice() {
            [line] => match line.as_slice() {
                [Token::Text(script)] => Ok(script.clone()),
                _ => Err(MailServerError::server("The filter server sent no script.")),
            },
            _ => Err(MailServerError::server("The filter server sent no script.")),
        }
    }

    /// Stores a script (the server checks it first: a refusal says why).
    async fn put_script(&mut self, name: &str, script: &str) -> Result<(), MailServerError> {
        let mut command = b"PUTSCRIPT ".to_vec();
        push_string(&mut command, name);
        command.push(b' ');
        push_literal(&mut command, script);
        command.extend_from_slice(b"\r\n");
        let (_, response) = self.command(&command).await?;
        ok(response, Step::Write)
    }

    /// Makes a script the active one.
    async fn set_active(&mut self, name: &str) -> Result<(), MailServerError> {
        let mut command = b"SETACTIVE ".to_vec();
        push_string(&mut command, name);
        command.extend_from_slice(b"\r\n");
        let (_, response) = self.command(&command).await?;
        ok(response, Step::Write)
    }

    /// Says goodbye (best effort).
    async fn logout(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.command(b"LOGOUT\r\n")).await;
    }
}

/// The account's filter server: the kept one, else one found and kept.
/// `notFound` when there's none.
#[tauri::command]
pub async fn sieve_find(
    imap: State<'_, Imap>,
    key: String,
) -> Result<SieveServer, MailServerError> {
    imap.find_sieve(&key).await
}

/// Uses this filter server from now on (checked by logging in), or
/// (`null`) forgets the kept one.
#[tauri::command]
pub async fn sieve_set_server(
    imap: State<'_, Imap>,
    key: String,
    server: Option<SieveAddress>,
) -> Result<Option<SieveServer>, MailServerError> {
    imap.set_sieve_server(&key, server).await
}

/// The kept filter server, without connecting (`null`: none kept yet).
#[tauri::command]
pub async fn sieve_known(
    imap: State<'_, Imap>,
    key: String,
) -> Result<Option<SieveServer>, MailServerError> {
    Ok(imap.account(&key)?.sieve)
}

/// The active script.
#[tauri::command]
pub async fn sieve_read(
    imap: State<'_, Imap>,
    key: String,
) -> Result<SieveScript, MailServerError> {
    imap.read_sieve(&key).await
}

/// Stores a script if the active one is still the one it was made from.
#[tauri::command]
pub async fn sieve_write(
    imap: State<'_, Imap>,
    key: String,
    request: SieveWrite,
) -> Result<(), MailServerError> {
    imap.write_sieve(&key, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::account::{MailServer, MailServerSettings, Security};
    use crate::imap::testing::{self, TestCa, scripted};
    use crate::imap::{ImapAuth, tls};
    use crate::vault::{FixedKey, LazyVault};
    use std::sync::Arc;
    use tokio::io::DuplexStream;

    /// "\0user\0pass" in base64.
    const PLAIN: &str = "AHVzZXIAcGFzcw==";

    const CAPABILITIES: &str = r#"
        S: "IMPLEMENTATION" "Dovecot Pigeonhole"
        S: "SIEVE" "fileinto reject envelope VACATION imap4flags body date relational"
        S: "NOTIFY" "mailto"
        S: "SASL" "PLAIN LOGIN OAUTHBEARER"
        S: "VERSION" "1.0"
        S: OK "Dovecot ready."
    "#;

    /// A client logged in over a scripted (already secure) stream.
    async fn logged_in(
        rest: &str,
    ) -> (
        Result<SieveClient<DuplexStream>, MailServerError>,
        tokio::task::JoinHandle<Result<(), String>>,
    ) {
        let (stream, task) = scripted(&format!(
            "{CAPABILITIES}
            C: AUTHENTICATE \"PLAIN\" \"{PLAIN}\"
            {rest}"
        ));
        let client = async {
            let mut client = SieveClient::start(stream).await?;
            client
                .authenticate("user", Secret::Password("pass"))
                .await?;
            Ok(client)
        }
        .await;
        (client, task)
    }

    #[test]
    fn reads_server_lines() {
        let mut tokens = Vec::new();
        let literal = tokenize(
            br#"NO (QUOTA/MAXSIZE) "Too \"big\" \\ now" ACTIVE {12}"#,
            &mut tokens,
        )
        .unwrap();
        assert_eq!(literal, Some(12));
        assert_eq!(
            tokens,
            vec![
                Token::Atom("NO".into()),
                Token::Open,
                Token::Atom("QUOTA/MAXSIZE".into()),
                Token::Close,
                Token::Text("Too \"big\" \\ now".into()),
                Token::Atom("ACTIVE".into()),
            ]
        );
        let response = Response::of(&tokens).unwrap();
        assert_eq!(response.status, Status::No);
        assert_eq!(response.code.as_deref(), Some("QUOTA/MAXSIZE"));
        assert_eq!(response.text, "Too \"big\" \\ now");
        assert!(tokenize(br#""unclosed"#, &mut Vec::new()).is_err());
        assert!(tokenize(b"{12x}", &mut Vec::new()).is_err());
        assert_eq!(tokenize(b"{3+}", &mut Vec::new()).unwrap(), Some(3));
        assert_eq!(
            Response::of(&[Token::Atom("ok".into())]),
            Some(Response {
                status: Status::Ok,
                code: None,
                text: String::new()
            })
        );
        assert_eq!(Response::of(&[Token::Text("SIEVE".into())]), None);
    }

    #[test]
    fn reads_capabilities() {
        let line = |text: &str| {
            let mut tokens = Vec::new();
            tokenize(text.as_bytes(), &mut tokens).unwrap();
            tokens
        };
        let capabilities = Capabilities::parse(&[
            line(r#""IMPLEMENTATION" "Cyrus timsieved""#),
            line(r#""Sieve" "FileInto Vacation body""#),
            line(r#""SASL" "plain xoauth2""#),
            line(r#""STARTTLS""#),
        ]);
        assert_eq!(capabilities.sieve, vec!["fileinto", "vacation", "body"]);
        assert!(capabilities.sasl("PLAIN") && capabilities.sasl("XOAUTH2"));
        assert!(!capabilities.sasl("LOGIN"));
        assert!(capabilities.starttls);
    }

    #[test]
    fn writes_strings_and_literals() {
        let mut out = Vec::new();
        push_string(&mut out, r#"My "best" \ filters"#);
        assert_eq!(out, br#""My \"best\" \\ filters""#);
        let mut out = Vec::new();
        push_string(&mut out, "two\nlines");
        assert_eq!(out, b"{9+}\r\ntwo\nlines");
        let mut out = Vec::new();
        push_string(&mut out, &"x".repeat(1025));
        assert!(out.starts_with(b"{1025+}\r\n"));
    }

    #[test]
    fn knows_some_providers() {
        assert_eq!(
            known("imap.mailbox.org"),
            Some(Known::At("imap.mailbox.org"))
        );
        assert_eq!(known("posteo.net"), Some(Known::At("posteo.de")));
        assert_eq!(known("imap.gmx.net"), Some(Known::Nowhere("GMX")));
        assert_eq!(
            known("outlook.office365.com"),
            Some(Known::Nowhere("Outlook"))
        );
        assert_eq!(known("imap.mail.me.com"), Some(Known::Nowhere("iCloud")));
        assert_eq!(known("imap.fastmail.com"), Some(Known::Nowhere("Fastmail")));
        assert_eq!(known("mail.example.org"), None);

        let mut account = account(1, None);
        assert_eq!(place_of(&account).unwrap(), "127.0.0.1");
        account.settings.imap.host = "imap.web.de".into();
        let error = place_of(&account).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(error.server, Some(ServerRole::Sieve));
        // A custom domain at a known host counts by the host.
        account.settings.imap.host = "imap.mailbox.org".into();
        assert_eq!(place_of(&account).unwrap(), "imap.mailbox.org");
        // An unknown host, but the address is a known provider's.
        account.settings.imap.host = "mail.example.org".into();
        account.address = "max@gmail.com".into();
        assert_eq!(place_of(&account).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn logs_in_reads_and_writes_scripts() {
        let script = "require \"fileinto\";\r\nif header :contains \"subject\" \"x\" { fileinto \"X\"; }\r\n";
        let (client, task) = logged_in(&format!(
            r#"
            S: OK "Logged in."
            C: LISTSCRIPTS
            S: "old"
            S: {{5}}
            S: rules ACTIVE
            S: OK "Listscripts completed."
            C: GETSCRIPT "rules"
            S: {{{}}}
            S: require "fileinto";
            S: if header :contains "subject" "x" {{ fileinto "X"; }}
            S:
            S: OK "Getscript completed."
            C: LISTSCRIPTS
            S: "rules" ACTIVE
            S: OK
            C: GETSCRIPT "rules"
            S: {{{}}}
            S: require "fileinto";
            S: if header :contains "subject" "x" {{ fileinto "X"; }}
            S:
            S: OK
            C: PUTSCRIPT "rules" {{6+}}
            C: keep;
            C:
            S: OK (WARNINGS) "line 1: nothing to do"
            C: LOGOUT
            S: OK "Logout completed."
            "#,
            script.len(),
            script.len()
        ))
        .await;
        let mut client = client.unwrap();
        assert_eq!(
            client.capabilities.sieve,
            vec![
                "fileinto",
                "reject",
                "envelope",
                "vacation",
                "imap4flags",
                "body",
                "date",
                "relational"
            ]
        );
        let active = client.active_script().await.unwrap();
        assert_eq!(active, Some(("rules".into(), script.into())));
        // Written as LF, read back as CRLF: still the same script.
        let request = SieveWrite {
            name: "rules".into(),
            script: "keep;\n".into(),
            expected: script.replace("\r\n", "\n"),
            activate: false,
        };
        write(&mut client, &request).await.unwrap();
        client.logout().await;
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn activates_a_new_script() {
        let (client, task) = logged_in(
            r#"
            S: OK
            C: LISTSCRIPTS
            S: OK
            C: PUTSCRIPT "action0" {6+}
            C: keep;
            C:
            S: OK
            C: SETACTIVE "action0"
            S: OK
            "#,
        )
        .await;
        let mut client = client.unwrap();
        let request = SieveWrite {
            name: "action0".into(),
            script: "keep;\n".into(),
            expected: String::new(),
            activate: true,
        };
        write(&mut client, &request).await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn refuses_to_write_over_changes() {
        let (client, task) = logged_in(
            r#"
            S: OK
            C: LISTSCRIPTS
            S: "rules" ACTIVE
            S: OK
            C: GETSCRIPT "rules"
            S: {7}
            S: stop;
            S:
            S: OK
            "#,
        )
        .await;
        let mut client = client.unwrap();
        let request = SieveWrite {
            name: "rules".into(),
            script: "discard;\n".into(),
            expected: "keep;\n".into(),
            activate: false,
        };
        let error = write(&mut client, &request).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Changed);
        assert_eq!(error.server, Some(ServerRole::Sieve));
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_script_says_why() {
        let (client, task) = logged_in(
            r#"
            S: OK
            C: PUTSCRIPT "rules" {4+}
            C: foo
            C:
            S: NO {30}
            S: line 1: unknown command 'foo'.
            "#,
        )
        .await;
        let error = client
            .unwrap()
            .put_script("rules", "foo\n")
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Rejected);
        assert_eq!(error.message, "line 1: unknown command 'foo'.");
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_password_is_auth() {
        let (client, task) = logged_in(r#"S: NO "Authentication failed.""#).await;
        let error = client.err().unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
        assert_eq!(error.server, Some(ServerRole::Sieve));
        assert_eq!(error.message, "Authentication failed.");
    }

    #[tokio::test]
    async fn answers_a_refused_token() {
        let initial = STANDARD.encode("n,a=user,\x01auth=Bearer tok\x01\x01");
        let (stream, task) = scripted(&format!(
            r#"{CAPABILITIES}
            C: AUTHENTICATE "OAUTHBEARER" "{initial}"
            S: "eyJzdGF0dXMiOiI0MDEifQ=="
            C: "AQ=="
            S: NO "Authentication failed."
            "#
        ));
        let mut client = SieveClient::start(stream).await.unwrap();
        let error = client
            .authenticate("user", Secret::Bearer("tok"))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Auth);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn requires_starttls() {
        let (stream, task) = scripted(
            r#"
            S: "IMPLEMENTATION" "Old"
            S: "SASL" "PLAIN"
            S: OK
            "#,
        );
        let error = starttls(stream).await.unwrap_err();
        task.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Tls);
    }

    #[tokio::test]
    async fn something_else_on_the_port_is_no_filter_server() {
        let (stream, task) = scripted("S: * OK [CAPABILITY IMAP4rev1] hi");
        let error = starttls(stream).await.err().unwrap();
        assert_eq!(error.kind, ErrorKind::NotFound);
        let _ = task.await;
    }

    /// A mail server account whose IMAP host is 127.0.0.1, with `pinned`.
    fn account(port: u16, pinned: Option<String>) -> ImapAccount {
        let server = MailServer {
            host: "127.0.0.1".into(),
            port,
            security: Security::Tls,
        };
        ImapAccount {
            address: "user@example.org".into(),
            name: "User".into(),
            settings: MailServerSettings {
                imap: server.clone(),
                smtp: server,
                username: "user".into(),
            },
            auth: ImapAuth::Password {
                password: "pass".into(),
            },
            pinned,
            max_bytes: None,
            sieve: None,
        }
    }

    fn imap(name: &str) -> (Imap, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("action0-sieve-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = rustls::crypto::ring::default_provider().install_default();
        let imap = Imap::new(
            crate::net::http_client(),
            LazyVault::new(dir.join("imap.vault"), Arc::new(FixedKey(vec![3; 32]))),
        );
        (imap, dir)
    }

    /// A filter server on localhost: plays `before` unencrypted, then
    /// `after` over TLS with `cert`.
    async fn server(
        cert: (Vec<u8>, Vec<u8>),
        before: &'static str,
        after: String,
    ) -> (u16, tokio::task::JoinHandle<Result<(), String>>) {
        let acceptor = testing::acceptor(cert);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut plain, _) = listener.accept().await.unwrap();
            testing::play(&mut plain, before).await?;
            let mut secure = acceptor.accept(plain).await.map_err(|e| e.to_string())?;
            testing::play(&mut secure, &after).await
        });
        (port, task)
    }

    const BEFORE_TLS: &str = r#"
        S: "IMPLEMENTATION" "Dovecot Pigeonhole"
        S: "SIEVE" "fileinto"
        S: "SASL" ""
        S: "STARTTLS"
        S: "VERSION" "1.0"
        S: OK "Dovecot ready."
        C: STARTTLS
        S: OK "Begin TLS negotiation now."
    "#;

    /// The whole way over TCP: STARTTLS, the handshake, the capabilities
    /// again, the login.
    #[tokio::test]
    async fn connects_over_starttls() {
        let ca = TestCa::new();
        let (port, task) = server(
            ca.issue("localhost"),
            BEFORE_TLS,
            format!(
                r#"{CAPABILITIES}
                C: AUTHENTICATE "PLAIN" "{PLAIN}"
                S: OK "Logged in."
                C: LOGOUT
                S: OK
                "#
            ),
        )
        .await;
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        let client = connect("localhost", port, &tls, "user", Secret::Password("pass"))
            .await
            .unwrap();
        // What counts is said after TLS.
        assert!(client.capabilities.sieve.contains(&"vacation".to_string()));
        assert!(client.capabilities.sasl("PLAIN"));
        client.logout().await;
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn an_untrusted_certificate_names_the_filter_server() {
        let ca = TestCa::new();
        let (port, task) = server(
            testing::self_signed(&["localhost"]),
            BEFORE_TLS,
            String::new(),
        )
        .await;
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        let error = connect("localhost", port, &tls, "user", Secret::Password("pass"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind, ErrorKind::Untrusted);
        assert_eq!(error.server, Some(ServerRole::Sieve));
        assert_eq!(error.certificate.unwrap().server, ServerRole::Sieve);
        let _ = task.await;
    }

    /// Choosing a server, then reading and writing through the account
    /// (its pinned certificate, its login, the kept server).
    #[tokio::test]
    async fn keeps_a_chosen_server_and_reads_and_writes_through_it() {
        let cert = testing::self_signed(&["filters.example.org"]);
        let pin = tls::fingerprint(&cert.0);
        let (imap, dir) = imap("chosen");
        let key = "imap:user@example.org";
        imap.vault().put(key, account(1, Some(pin)));

        // Choosing it logs in once.
        let (port, task) = server(
            cert.clone(),
            BEFORE_TLS,
            format!(
                r#"{CAPABILITIES}
                C: AUTHENTICATE "PLAIN" "{PLAIN}"
                S: OK
                C: LOGOUT
                S: OK
                "#
            ),
        )
        .await;
        let chosen = imap
            .set_sieve_server(
                key,
                Some(SieveAddress {
                    host: " 127.0.0.1 ".into(),
                    port,
                }),
            )
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();
        assert!(chosen.chosen);
        assert_eq!(chosen.host, "127.0.0.1");
        assert_eq!(imap.account(key).unwrap().sieve, Some(chosen.clone()));
        // Kept: finding it doesn't connect.
        assert_eq!(imap.find_sieve(key).await.unwrap(), chosen);

        // Reading: no script is active yet; the extensions changed meanwhile.
        let (port2, task) = server(
            cert.clone(),
            BEFORE_TLS,
            format!(
                r#"
                S: "SIEVE" "fileinto vacation"
                S: "SASL" "PLAIN"
                S: OK
                C: AUTHENTICATE "PLAIN" "{PLAIN}"
                S: OK
                C: LISTSCRIPTS
                S: "unused"
                S: OK
                C: LOGOUT
                S: OK
                "#
            ),
        )
        .await;
        imap.update(key, |account| {
            if let Some(server) = &mut account.sieve {
                server.port = port2;
            }
        })
        .unwrap();
        let read = imap.read_sieve(key).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            read,
            SieveScript {
                name: None,
                script: String::new(),
                extensions: vec!["fileinto".into(), "vacation".into()],
            }
        );
        assert_eq!(
            imap.account(key).unwrap().sieve.unwrap().extensions,
            vec!["fileinto", "vacation"]
        );
        assert_eq!(
            serde_json::to_value(&read).unwrap(),
            serde_json::json!({"script": "", "extensions": ["fileinto", "vacation"]})
        );

        // Forgetting it.
        assert_eq!(imap.set_sieve_server(key, None).await.unwrap(), None);
        assert_eq!(imap.account(key).unwrap().sieve, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_known_provider_without_filters_says_so_at_once() {
        let (imap, dir) = imap("nowhere");
        let key = "imap:user@example.org";
        let mut kept = account(1, None);
        kept.settings.imap.host = "imap.gmx.net".into();
        imap.vault().put(key, kept);
        let error = imap.find_sieve(key).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(error.message, "GMX offers no filters to mail programs.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_ui_gets_the_server_as_it_expects() {
        let server = SieveServer {
            host: "imap.example.org".into(),
            port: 4190,
            extensions: vec!["fileinto".into()],
            chosen: false,
        };
        assert_eq!(
            serde_json::to_value(&server).unwrap(),
            serde_json::json!({
                "host": "imap.example.org",
                "port": 4190,
                "extensions": ["fileinto"],
                "chosen": false,
            })
        );
        let request: SieveWrite = serde_json::from_value(serde_json::json!({
            "name": "action0",
            "script": "keep;",
            "expected": "",
            "activate": true,
        }))
        .unwrap();
        assert!(request.activate);
    }
}
