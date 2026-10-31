//! Sending over SMTP submission: TLS from the start (465) or STARTTLS that's
//! required (587), AUTH PLAIN or LOGIN with a password, OAUTHBEARER or
//! XOAUTH2 with a token, then `MAIL FROM` (with `SIZE`), `RCPT TO` and
//! `DATA`. A small client of our own: lettre 0.11 builds its rustls config
//! itself, so it couldn't check certificates like IMAP does here (the
//! pinned certificate, and the details of a refused one).
//!
//! Replies map to the UI's error kinds: 535 and the like are `auth`, 552
//! `tooBig`, other 5xx on `MAIL`, `RCPT` or `DATA` `rejected` (with the
//! server's text), 4xx (try later) `server`.

use std::collections::BTreeSet;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::account::Security;
use super::error::{ErrorKind, MailServerError, ServerRole};
use super::session::{CONNECT_TIMEOUT, Login, Secret, Stream, Transport, tcp};
use super::tls::Connector;

/// How long a reply may take (the one after the mail's end: see below).
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long sending the mail and the server's verdict on it may take.
const DATA_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The longest reply line read (RFC 5321 says 512).
const LINE_LIMIT: u64 = 8 * 1024;

/// Who a mail goes to, and from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub from: String,
    pub to: Vec<String>,
}

/// Logs in to the SMTP server, and out again; the most bytes a mail may
/// have (`SIZE`), if the server says.
pub async fn check(login: &Login<'_>, tls: &Connector) -> Result<Option<u64>, MailServerError> {
    let client = open(login, tls).await?;
    let size = client.extensions.size;
    client.quit().await;
    Ok(size)
}

/// Sends `message` (the whole mail, CRLF or LF lines) as `envelope` says.
pub async fn send(
    login: &Login<'_>,
    tls: &Connector,
    envelope: &Envelope,
    message: &[u8],
) -> Result<(), MailServerError> {
    check_envelope(envelope)?;
    let mut client = open(login, tls).await?;
    let sent = client.transmit(envelope, message).await;
    client.quit().await;
    sent
}

/// Connects, secures and logs in.
async fn open(login: &Login<'_>, tls: &Connector) -> Result<SmtpClient<Stream>, MailServerError> {
    let server = login.server;
    let tcp = tcp(&server.host, server.port).await?;
    let hello = match tcp.local_addr() {
        Ok(std::net::SocketAddr::V4(address)) => format!("[{}]", address.ip()),
        Ok(std::net::SocketAddr::V6(address)) => format!("[IPv6:{}]", address.ip()),
        Err(_) => "[127.0.0.1]".to_string(),
    };
    let client = tokio::time::timeout(CONNECT_TIMEOUT, async {
        match server.security {
            Security::Tls => {
                let secure = tls.handshake(&server.host, tcp, ServerRole::Smtp).await?;
                SmtpClient::start(Box::new(secure) as Stream, &hello, true).await
            }
            Security::Starttls => {
                let plain = starttls(tcp, &hello).await?;
                let secure = tls.handshake(&server.host, plain, ServerRole::Smtp).await?;
                SmtpClient::start(Box::new(secure) as Stream, &hello, false).await
            }
        }
    })
    .await
    .map_err(|_| {
        MailServerError::unreachable(format!(
            "{}:{} didn't answer in time. Are the port and security right?",
            server.host, server.port
        ))
    })?;
    let mut client = client.map_err(|error| error.on(ServerRole::Smtp))?;
    client.login(login.username, login.secret).await?;
    Ok(client)
}

/// The unencrypted start of STARTTLS: greeting, `EHLO`, `STARTTLS`. The
/// stream, ready for the TLS handshake; a server without STARTTLS is
/// refused (`tls`).
pub async fn starttls<S: Transport>(stream: S, hello: &str) -> Result<S, MailServerError> {
    let mut client = SmtpClient::start(stream, hello, true).await?;
    if !client.extensions.has("STARTTLS") {
        return Err(MailServerError::tls(
            "The SMTP server doesn't offer STARTTLS, and action0 never logs in unencrypted.",
        ));
    }
    let reply = client.command("STARTTLS").await?;
    if reply.code != 220 {
        return Err(MailServerError::tls(format!(
            "The SMTP server refused STARTTLS: {}",
            reply.text()
        )));
    }
    // Anything sent after the 220 would be an injection: refuse it.
    if !client.io.buffer().is_empty() {
        return Err(MailServerError::tls(
            "The SMTP server sent more than it should before TLS.",
        ));
    }
    Ok(client.io.into_inner())
}

/// What `EHLO` said the server can do.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extensions {
    names: BTreeSet<String>,
    auth: BTreeSet<String>,
    /// `SIZE`, if it names a limit.
    pub size: Option<u64>,
}

impl Extensions {
    pub fn has(&self, name: &str) -> bool {
        self.names.contains(&name.to_ascii_uppercase())
    }

    pub fn auth(&self, mechanism: &str) -> bool {
        self.auth.contains(&mechanism.to_ascii_uppercase())
    }

    /// From the lines of the `EHLO` reply (the first is the server's name).
    fn parse(lines: &[String]) -> Self {
        let mut extensions = Self::default();
        for line in lines.iter().skip(1) {
            let mut words = line.split_whitespace();
            let Some(keyword) = words.next() else {
                continue;
            };
            let keyword = keyword.to_ascii_uppercase();
            // Old servers write `AUTH=PLAIN LOGIN`.
            if let Some(first) = keyword.strip_prefix("AUTH=") {
                extensions.auth.insert(first.to_string());
                extensions
                    .auth
                    .extend(words.map(|w| w.to_ascii_uppercase()));
                extensions.names.insert("AUTH".into());
                continue;
            }
            match keyword.as_str() {
                "AUTH" => extensions
                    .auth
                    .extend(words.map(|w| w.to_ascii_uppercase())),
                "SIZE" => {
                    extensions.size = words
                        .next()
                        .and_then(|n| n.parse::<u64>().ok())
                        .filter(|&n| n > 0);
                }
                _ => {}
            }
            extensions.names.insert(keyword);
        }
        extensions
    }
}

/// An SMTP reply.
#[derive(Debug)]
struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        let text = self.lines.join(" ");
        if text.is_empty() {
            self.code.to_string()
        } else {
            format!("{} {text}", self.code)
        }
    }
}

/// What a refused step was.
#[derive(Clone, Copy)]
enum Step<'a> {
    Login,
    From,
    To(&'a str),
    Data,
}

/// What a refusal means for the UI.
fn refusal(reply: &Reply, step: Step<'_>) -> MailServerError {
    let text = reply.text();
    let kind = match (reply.code, step) {
        (535 | 534 | 538 | 530, _) => ErrorKind::Auth,
        (500..=599, Step::Login) => ErrorKind::Auth,
        (552, _) => ErrorKind::TooBig,
        (500..=599, _) => ErrorKind::Rejected,
        _ => ErrorKind::Server,
    };
    let message = match step {
        Step::To(address) => format!("{address}: {text}"),
        _ => text,
    };
    MailServerError::new(kind, message).on(ServerRole::Smtp)
}

/// A conversation with an SMTP server.
struct SmtpClient<S> {
    io: BufReader<S>,
    extensions: Extensions,
}

impl<S: AsyncRead + AsyncWrite + Unpin> SmtpClient<S> {
    /// Reads the greeting (if `greeting`; after STARTTLS there's none) and
    /// says `EHLO`.
    async fn start(stream: S, hello: &str, greeting: bool) -> Result<Self, MailServerError> {
        let mut client = Self {
            io: BufReader::new(stream),
            extensions: Extensions::default(),
        };
        if greeting {
            let reply = client.reply(REPLY_TIMEOUT).await?;
            if reply.code != 220 {
                return Err(MailServerError::server(format!(
                    "The SMTP server turned the connection away: {}",
                    reply.text()
                )));
            }
        }
        let reply = client.command(&format!("EHLO {hello}")).await?;
        if reply.code != 250 {
            return Err(MailServerError::server(format!(
                "The SMTP server didn't take EHLO: {}",
                reply.text()
            )));
        }
        client.extensions = Extensions::parse(&reply.lines);
        Ok(client)
    }

    /// Reads one reply (all its lines).
    async fn reply(&mut self, wait: Duration) -> Result<Reply, MailServerError> {
        tokio::time::timeout(wait, async {
            let mut lines = Vec::new();
            loop {
                let mut line = Vec::new();
                (&mut self.io)
                    .take(LINE_LIMIT)
                    .read_until(b'\n', &mut line)
                    .await?;
                if line.is_empty() {
                    return Err(MailServerError::unreachable(
                        "The SMTP server closed the connection.",
                    ));
                }
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches(['\r', '\n']);
                let code = line
                    .get(..3)
                    .and_then(|code| code.parse::<u16>().ok())
                    .filter(|code| (200..600).contains(code))
                    .ok_or_else(|| {
                        MailServerError::server(format!("Not an SMTP reply: {line:.80}"))
                    })?;
                let more = line.as_bytes().get(3) == Some(&b'-');
                lines.push(line.get(4..).unwrap_or_default().to_string());
                if !more || lines.len() > 200 {
                    return Ok(Reply { code, lines });
                }
            }
        })
        .await?
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), MailServerError> {
        let stream = self.io.get_mut();
        stream.write_all(bytes).await?;
        stream.flush().await?;
        Ok(())
    }

    /// Sends a command line and reads the reply.
    async fn command(&mut self, line: &str) -> Result<Reply, MailServerError> {
        tokio::time::timeout(REPLY_TIMEOUT, self.write(format!("{line}\r\n").as_bytes())).await??;
        self.reply(REPLY_TIMEOUT).await
    }

    /// Logs in the best way the server offers.
    async fn login(&mut self, username: &str, secret: Secret<'_>) -> Result<(), MailServerError> {
        let reply = match secret {
            Secret::Password(password) if self.extensions.auth("PLAIN") => {
                let initial = STANDARD.encode(format!("\0{username}\0{password}"));
                self.command(&format!("AUTH PLAIN {initial}")).await?
            }
            Secret::Password(password) if self.extensions.auth("LOGIN") => {
                let reply = self.command("AUTH LOGIN").await?;
                if reply.code != 334 {
                    return Err(refusal(&reply, Step::Login));
                }
                let reply = self.command(&STANDARD.encode(username)).await?;
                if reply.code != 334 {
                    return Err(refusal(&reply, Step::Login));
                }
                self.command(&STANDARD.encode(password)).await?
            }
            Secret::Password(_) => {
                return Err(MailServerError::server(
                    "The SMTP server offers no password login (AUTH PLAIN or LOGIN).",
                )
                .on(ServerRole::Smtp));
            }
            Secret::Bearer(token) => {
                let (mechanism, initial, later) = if self.extensions.auth("OAUTHBEARER") {
                    (
                        "OAUTHBEARER",
                        format!("n,a={},\x01auth=Bearer {token}\x01\x01", gs2_name(username)),
                        "AQ==",
                    )
                } else {
                    (
                        "XOAUTH2",
                        format!("user={username}\x01auth=Bearer {token}\x01\x01"),
                        "",
                    )
                };
                let reply = self
                    .command(&format!("AUTH {mechanism} {}", STANDARD.encode(initial)))
                    .await?;
                // A refusal first sends its details (334) and wants an answer.
                if reply.code == 334 {
                    self.command(later).await?
                } else {
                    reply
                }
            }
        };
        if reply.code == 235 {
            Ok(())
        } else {
            Err(refusal(&reply, Step::Login))
        }
    }

    /// The mail transaction: `MAIL FROM`, `RCPT TO` for each, `DATA`.
    async fn transmit(
        &mut self,
        envelope: &Envelope,
        message: &[u8],
    ) -> Result<(), MailServerError> {
        if let Some(size) = self.extensions.size
            && message.len() as u64 > size
        {
            return Err(MailServerError::new(
                ErrorKind::TooBig,
                format!(
                    "The mail has {} bytes; the SMTP server takes {size} at most.",
                    message.len()
                ),
            )
            .on(ServerRole::Smtp));
        }
        let mut parameters = String::new();
        if self.extensions.has("SIZE") {
            parameters.push_str(&format!(" SIZE={}", message.len()));
        }
        if !message.is_ascii() && self.extensions.has("8BITMIME") {
            parameters.push_str(" BODY=8BITMIME");
        }
        let addresses = std::iter::once(&envelope.from).chain(&envelope.to);
        if addresses.clone().any(|address| !address.is_ascii()) {
            if !self.extensions.has("SMTPUTF8") {
                return Err(MailServerError::new(
                    ErrorKind::Rejected,
                    "The SMTP server can't send to or from addresses with non-ASCII characters.",
                )
                .on(ServerRole::Smtp));
            }
            parameters.push_str(" SMTPUTF8");
        }

        let reply = self
            .command(&format!("MAIL FROM:<{}>{parameters}", envelope.from))
            .await?;
        if reply.code != 250 {
            return Err(refusal(&reply, Step::From));
        }
        for to in &envelope.to {
            let reply = self.command(&format!("RCPT TO:<{to}>")).await?;
            if reply.code != 250 && reply.code != 251 {
                return Err(refusal(&reply, Step::To(to)));
            }
        }
        let reply = self.command("DATA").await?;
        if reply.code != 354 {
            return Err(refusal(&reply, Step::Data));
        }
        tokio::time::timeout(DATA_TIMEOUT, self.write(&dot_stuffed(message))).await??;
        let reply = self.reply(DATA_TIMEOUT).await?;
        if reply.code != 250 {
            return Err(refusal(&reply, Step::Data));
        }
        Ok(())
    }

    /// Says goodbye (best effort).
    async fn quit(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.command("QUIT")).await;
    }
}

/// Escapes a SASL GS2 name (`=` and `,`).
pub(crate) fn gs2_name(name: &str) -> String {
    name.replace('=', "=3D").replace(',', "=2C")
}

/// Refuses addresses that would break the commands they go in.
fn check_envelope(envelope: &Envelope) -> Result<(), MailServerError> {
    let bad = |address: &String| {
        address.is_empty()
            || !address.contains('@')
            || address
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '<' || c == '>')
    };
    if envelope.to.is_empty() {
        return Err(MailServerError::new(
            ErrorKind::Rejected,
            "The mail has no recipients.",
        ));
    }
    if let Some(address) = std::iter::once(&envelope.from)
        .chain(&envelope.to)
        .find(|a| bad(a))
    {
        return Err(MailServerError::new(
            ErrorKind::Rejected,
            format!("Not an address: {address:?}"),
        ));
    }
    Ok(())
}

/// The mail as `DATA` sends it: CRLF line ends (lone CRs and LFs become
/// CRLF), lines starting with "." get another, then the closing ".".
pub fn dot_stuffed(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + message.len() / 64 + 5);
    let mut line_start = true;
    let mut i = 0;
    while i < message.len() {
        let byte = message[i];
        if line_start && byte == b'.' {
            out.push(b'.');
        }
        match byte {
            b'\r' | b'\n' => {
                out.extend_from_slice(b"\r\n");
                line_start = true;
                if byte == b'\r' && message.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
            }
            _ => {
                out.push(byte);
                line_start = false;
            }
        }
        i += 1;
    }
    if !line_start {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::account::MailServer;
    use crate::imap::testing::{self, TestCa, scripted};

    fn server() -> MailServer {
        MailServer {
            host: "smtp.example.org".into(),
            port: 465,
            security: Security::Tls,
        }
    }

    /// "\0user\0pass" in base64.
    const PLAIN: &str = "AHVzZXIAcGFzcw==";

    const GREETING: &str = "
        S: 220 smtp.example.org ESMTP ready
        C: EHLO [127.0.0.1]
        S: 250-smtp.example.org Hello
        S: 250-SIZE 1000
        S: 250-8BITMIME
        S: 250-AUTH PLAIN LOGIN
        S: 250 ENHANCEDSTATUSCODES
    ";

    async fn logged_in(
        script: &str,
        secret: Secret<'_>,
    ) -> (
        Result<SmtpClient<tokio::io::DuplexStream>, MailServerError>,
        tokio::task::JoinHandle<Result<(), String>>,
    ) {
        let (stream, task) = scripted(script);
        let client = async {
            let mut client = SmtpClient::start(stream, "[127.0.0.1]", true).await?;
            client.login("user", secret).await?;
            Ok(client)
        }
        .await;
        (client, task)
    }

    #[test]
    fn reads_what_ehlo_says() {
        let lines: Vec<String> = [
            "smtp.example.org",
            "SIZE 35882577",
            "AUTH=PLAIN LOGIN",
            "auth XOAUTH2 oauthbearer",
            "STARTTLS",
            "SMTPUTF8",
        ]
        .map(String::from)
        .to_vec();
        let extensions = Extensions::parse(&lines);
        assert_eq!(extensions.size, Some(35_882_577));
        assert!(extensions.auth("plain") && extensions.auth("LOGIN"));
        assert!(extensions.auth("XOAUTH2") && extensions.auth("OAUTHBEARER"));
        assert!(extensions.has("starttls") && extensions.has("SMTPUTF8"));
        assert!(!extensions.has("smtp.example.org"));
        let unlimited = Extensions::parse(&["x".into(), "SIZE".into()]);
        assert!(unlimited.has("SIZE"));
        assert_eq!(unlimited.size, None);
    }

    #[test]
    fn stuffs_dots_and_ends_lines_with_crlf() {
        assert_eq!(
            dot_stuffed(b"a\r\n.b\r\n..c\r\n"),
            b"a\r\n..b\r\n...c\r\n.\r\n"
        );
        assert_eq!(dot_stuffed(b".\nx\ry"), b"..\r\nx\r\ny\r\n.\r\n");
        assert_eq!(dot_stuffed(b""), b".\r\n");
        assert_eq!(dot_stuffed(b"x.\r\n"), b"x.\r\n.\r\n");
    }

    #[test]
    fn refuses_addresses_that_would_break_commands() {
        let envelope = |from: &str, to: &[&str]| Envelope {
            from: from.into(),
            to: to.iter().map(|s| s.to_string()).collect(),
        };
        assert!(check_envelope(&envelope("a@b.c", &["d@e.f"])).is_ok());
        for bad in [
            envelope("a@b.c", &[]),
            envelope("a@b.c>\r\nRCPT TO:<x@y.z", &["d@e.f"]),
            envelope("a@b.c", &["d@e.f> NOTIFY=NEVER"]),
            envelope("", &["d@e.f"]),
        ] {
            assert_eq!(check_envelope(&bad).unwrap_err().kind, ErrorKind::Rejected);
        }
    }

    #[tokio::test]
    async fn logs_in_and_sends_with_size_and_8bitmime() {
        let script = format!(
            "{GREETING}
            C: AUTH PLAIN {PLAIN}
            S: 235 2.7.0 Authentication successful
            C: MAIL FROM:<max@example.org> SIZE=22 BODY=8BITMIME
            S: 250 2.1.0 Ok
            C: RCPT TO:<anna@example.org>
            S: 250 2.1.5 Ok
            C: RCPT TO:<bob@example.org>
            S: 251 2.1.5 Will forward
            C: DATA
            S: 354 End data with <CR><LF>.<CR><LF>
            C: Subject: Grüße
            C:
            C: ..hi
            C: .
            S: 250 2.0.0 Ok: queued as 12345
            C: QUIT
            S: 221 2.0.0 Bye
            "
        );
        let (client, task) = logged_in(&script, Secret::Password("pass")).await;
        let mut client = client.unwrap();
        assert_eq!(client.extensions.size, Some(1000));
        let envelope = Envelope {
            from: "max@example.org".into(),
            to: vec!["anna@example.org".into(), "bob@example.org".into()],
        };
        client
            .transmit(&envelope, "Subject: Grüße\n\n.hi\n".as_bytes())
            .await
            .unwrap();
        client.quit().await;
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn logs_in_with_auth_login() {
        let script = "
            S: 220 ready
            C: EHLO [127.0.0.1]
            S: 250-hello
            S: 250 AUTH=LOGIN
            C: AUTH LOGIN
            S: 334 VXNlcm5hbWU6
            C: dXNlcg==
            S: 334 UGFzc3dvcmQ6
            C: cGFzcw==
            S: 235 ok
        ";
        let (client, task) = logged_in(script, Secret::Password("pass")).await;
        client.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_password_is_auth() {
        let script = format!(
            "{GREETING}
            C: AUTH PLAIN {PLAIN}
            S: 535 5.7.8 Error: authentication failed
            "
        );
        let (client, task) = logged_in(&script, Secret::Password("pass")).await;
        let error = client.err().unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
        assert_eq!(error.server, Some(ServerRole::Smtp));
        assert_eq!(error.message, "535 5.7.8 Error: authentication failed");
    }

    #[tokio::test]
    async fn answers_a_refused_xoauth2_token() {
        let initial = STANDARD.encode("user=user\x01auth=Bearer tok\x01\x01");
        let script = format!(
            "
            S: 220 ready
            C: EHLO [127.0.0.1]
            S: 250-hello
            S: 250 AUTH LOGIN PLAIN XOAUTH2
            C: AUTH XOAUTH2 {initial}
            S: 334 eyJzdGF0dXMiOiI0MDAifQ==
            C:
            S: 535 5.7.8 Username and Password not accepted
            "
        );
        let (client, task) = logged_in(&script, Secret::Bearer("tok")).await;
        assert_eq!(client.err().unwrap().kind, ErrorKind::Auth);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn signs_in_with_oauthbearer() {
        let initial = STANDARD.encode("n,a=user,\x01auth=Bearer tok\x01\x01");
        let script = format!(
            "
            S: 220 ready
            C: EHLO [127.0.0.1]
            S: 250-hello
            S: 250 AUTH XOAUTH2 OAUTHBEARER
            C: AUTH OAUTHBEARER {initial}
            S: 235 ok
            "
        );
        let (client, task) = logged_in(&script, Secret::Bearer("tok")).await;
        client.unwrap();
        task.await.unwrap().unwrap();
    }

    async fn transmit_refused(steps: &str, message: &[u8]) -> MailServerError {
        let script = format!(
            "{GREETING}
            C: AUTH PLAIN {PLAIN}
            S: 235 ok
            {steps}"
        );
        let (client, task) = logged_in(&script, Secret::Password("pass")).await;
        let envelope = Envelope {
            from: "max@example.org".into(),
            to: vec!["nobody@example.org".into()],
        };
        let error = client
            .unwrap()
            .transmit(&envelope, message)
            .await
            .unwrap_err();
        task.await.unwrap().unwrap();
        error
    }

    #[tokio::test]
    async fn tells_refusals_apart() {
        let error = transmit_refused(
            "
            C: MAIL FROM:<max@example.org> SIZE=2
            S: 250 ok
            C: RCPT TO:<nobody@example.org>
            S: 550 5.1.1 User unknown
            ",
            b"hi",
        )
        .await;
        assert_eq!(error.kind, ErrorKind::Rejected);
        assert_eq!(error.message, "nobody@example.org: 550 5.1.1 User unknown");

        let error = transmit_refused(
            "
            C: MAIL FROM:<max@example.org> SIZE=2
            S: 250 ok
            C: RCPT TO:<nobody@example.org>
            S: 250 ok
            C: DATA
            S: 354 go
            C: hi
            C: .
            S: 552 5.3.4 Message size exceeds fixed limit
            ",
            b"hi",
        )
        .await;
        assert_eq!(error.kind, ErrorKind::TooBig);

        let error = transmit_refused(
            "
            C: MAIL FROM:<max@example.org> SIZE=2
            S: 451 4.3.0 Try again later
            ",
            b"hi",
        )
        .await;
        assert_eq!(error.kind, ErrorKind::Server);

        // Bigger than SIZE: nothing is sent.
        let error = transmit_refused("", &[b'x'; 1001]).await;
        assert_eq!(error.kind, ErrorKind::TooBig);
    }

    #[tokio::test]
    async fn requires_starttls() {
        let (stream, task) = scripted(
            "
            S: 220 ready
            C: EHLO [127.0.0.1]
            S: 250-hello
            S: 250 AUTH PLAIN
            ",
        );
        let error = starttls(stream, "[127.0.0.1]").await.unwrap_err();
        task.await.unwrap().unwrap();
        assert_eq!(error.kind, ErrorKind::Tls);
    }

    /// The whole way over TCP: STARTTLS, the handshake, a new EHLO, the
    /// login and the check's QUIT.
    #[tokio::test]
    async fn checks_a_login_over_starttls() {
        let ca = TestCa::new();
        let acceptor = testing::acceptor(ca.issue("localhost"));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut plain, _) = listener.accept().await.unwrap();
            testing::play(
                &mut plain,
                "
                S: 220 ready
                C: EHLO [127.0.0.1]
                S: 250-hello
                S: 250-SIZE 52428800
                S: 250 STARTTLS
                C: STARTTLS
                S: 220 2.0.0 Ready to start TLS
                ",
            )
            .await?;
            let mut secure = acceptor.accept(plain).await.map_err(|e| e.to_string())?;
            testing::play(
                &mut secure,
                &format!(
                    "
                    C: EHLO [127.0.0.1]
                    S: 250-hello
                    S: 250-SIZE 36700160
                    S: 250 AUTH PLAIN
                    C: AUTH PLAIN {PLAIN}
                    S: 235 ok
                    C: QUIT
                    S: 221 bye
                    "
                ),
            )
            .await
        });
        let smtp = MailServer {
            host: "localhost".into(),
            port,
            security: Security::Starttls,
        };
        let login = Login {
            server: &smtp,
            username: "user",
            secret: Secret::Password("pass"),
        };
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        // The size after STARTTLS counts.
        assert_eq!(check(&login, &tls).await.unwrap(), Some(36_700_160));
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn an_untrusted_certificate_names_the_smtp_server() {
        let ca = TestCa::new();
        let acceptor = testing::acceptor(testing::self_signed(&["localhost"]));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (plain, _) = listener.accept().await.unwrap();
            let _ = acceptor.accept(plain).await;
        });
        let smtp = MailServer {
            host: "localhost".into(),
            port,
            ..server()
        };
        let login = Login {
            server: &smtp,
            username: "user",
            secret: Secret::Password("pass"),
        };
        let tls = Connector::with_verifier(ca.verifier(), None).unwrap();
        let error = check(&login, &tls).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Untrusted);
        assert_eq!(error.server, Some(ServerRole::Smtp));
        assert_eq!(error.certificate.unwrap().server, ServerRole::Smtp);
        let _ = task.await;
    }
}
