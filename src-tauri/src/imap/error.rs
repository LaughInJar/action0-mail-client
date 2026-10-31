//! What goes wrong with mail servers, as the UI tells it apart: the
//! `MailServerError` of `src/accounts/mailServer.ts`.

use serde::{Deserialize, Serialize};

/// Why a call failed (see `MailServerError` in `mailServer.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    /// The server refused the password or sign-in: the UI offers Reconnect.
    #[serde(rename = "auth")]
    Auth,
    /// The certificate isn't trusted (or isn't the pinned one).
    #[serde(rename = "untrusted")]
    Untrusted,
    /// TLS or STARTTLS failed, or the server offers no encryption.
    #[serde(rename = "tls")]
    Tls,
    /// No connection: offline, wrong host or port, a timeout.
    #[serde(rename = "unreachable")]
    Unreachable,
    /// The Yahoo/AOL sign-in failed or was cancelled.
    #[serde(rename = "oauth")]
    OAuth,
    /// The message, folder or account is gone.
    #[serde(rename = "notFound")]
    NotFound,
    /// A folder with that name exists.
    #[serde(rename = "exists")]
    Exists,
    /// The SMTP server refused the mail's size.
    #[serde(rename = "tooBig")]
    TooBig,
    /// The SMTP server refused a recipient or the mail.
    #[serde(rename = "rejected")]
    Rejected,
    /// The server answered NO or BAD (or something else unexpected).
    #[serde(rename = "server")]
    Server,
}

/// Which of an account's servers something concerns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerRole {
    Imap,
    Smtp,
    /// The calendar server (CalDAV).
    Caldav,
}

/// A certificate the system doesn't trust, for the user to decide on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailServerCertificate {
    /// SHA-256 of the DER, upper-case hex, colon-separated.
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    /// ISO 8601.
    pub not_before: String,
    pub not_after: String,
    /// The host names (and addresses) it's for.
    pub names: Vec<String>,
    /// Which server showed it.
    pub server: ServerRole,
}

/// A failed call, as the UI gets it: `{kind, message, server?, certificate?}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{kind:?}: {message}")]
pub struct MailServerError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate: Option<Box<MailServerCertificate>>,
}

impl MailServerError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            server: None,
            certificate: None,
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message)
    }

    pub fn tls(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Tls, message)
    }

    pub fn unreachable(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unreachable, message)
    }

    pub fn server(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Server, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    /// The same error, said to concern `server` (unless it already names one).
    pub fn on(mut self, server: ServerRole) -> Self {
        self.server.get_or_insert(server);
        self
    }

    /// True if the connection itself failed (it's worth a new one).
    pub fn is_connection(&self) -> bool {
        self.kind == ErrorKind::Unreachable
    }

    /// A NO or BAD answer, by its response code (RFC 5530) and text.
    pub fn answered(detail: &str) -> Self {
        let (code, text) = answer_text(detail);
        let kind = match code.as_deref() {
            Some("NONEXISTENT" | "TRYCREATE") => ErrorKind::NotFound,
            Some("ALREADYEXISTS") => ErrorKind::Exists,
            Some("AUTHENTICATIONFAILED" | "AUTHORIZATIONFAILED" | "EXPIRED") => ErrorKind::Auth,
            _ => ErrorKind::Server,
        };
        Self::new(kind, text)
    }
}

impl From<std::io::Error> for MailServerError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::TimedOut {
            return Self::unreachable("The server didn't answer in time.");
        }
        Self::unreachable(format!("The connection broke off: {error}"))
    }
}

impl From<tokio::time::error::Elapsed> for MailServerError {
    fn from(_: tokio::time::error::Elapsed) -> Self {
        Self::unreachable("The server didn't answer in time.")
    }
}

/// async-imap's errors: NO/BAD keep the server's text, a lost
/// connection is `unreachable`.
impl From<async_imap::error::Error> for MailServerError {
    fn from(error: async_imap::error::Error) -> Self {
        use async_imap::error::Error;
        match error {
            Error::Io(error) => error.into(),
            Error::ConnectionLost => Self::unreachable("The server closed the connection."),
            Error::No(detail) | Error::Bad(detail) => Self::answered(&detail),
            Error::Append => Self::server("The server didn't store the message."),
            other => Self::server(other.to_string()),
        }
    }
}

/// The response code and the text of async-imap's NO/BAD detail, which
/// reads `code: Some(TryCreate), info: Some("[CODE] text")` or `outcome:
/// Outcome { code: …, information: Some("…") }`. Codes imap-proto doesn't
/// know stay in the text, in brackets.
pub fn answer_text(detail: &str) -> (Option<String>, String) {
    let after = |marker: &str| {
        detail
            .find(marker)
            .map(|start| &detail[start + marker.len()..])
    };
    let known = after("code: Some(")
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_alphanumeric()).next())
        .map(str::to_ascii_uppercase);
    let info = after("info: Some(\"")
        .or_else(|| after("information: Some(\""))
        .and_then(|rest| rest.rfind("\")").map(|end| unescape(&rest[..end])));
    let Some(info) = info else {
        return (known, detail.to_string());
    };
    if let Some(rest) = info.strip_prefix('[')
        && let Some((code, text)) = rest.split_once(']')
    {
        let code = code
            .split(' ')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let text = text.trim();
        let text = if text.is_empty() { info.as_str() } else { text };
        return (Some(code), text.to_string());
    }
    (known, info)
}

/// Undoes Rust's `{:?}` escaping of a string.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('u') => {
                let code: String = chars
                    .by_ref()
                    .skip_while(|&c| c == '{')
                    .take_while(|&c| c != '}')
                    .collect();
                if let Some(c) = u32::from_str_radix(&code, 16).ok().and_then(char::from_u32) {
                    out.push(c);
                }
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_the_ui_in_its_shape() {
        let error = MailServerError::new(ErrorKind::TooBig, "552 too big").on(ServerRole::Smtp);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"kind": "tooBig", "message": "552 too big", "server": "smtp"})
        );
        let json = serde_json::to_value(MailServerError::new(ErrorKind::OAuth, "x")).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "oauth", "message": "x"}));
        let json = serde_json::to_value(MailServerError::not_found("gone")).unwrap();
        assert_eq!(json["kind"], "notFound");
    }

    #[test]
    fn keeps_the_first_server_named() {
        let error = MailServerError::tls("x")
            .on(ServerRole::Smtp)
            .on(ServerRole::Imap);
        assert_eq!(error.server, Some(ServerRole::Smtp));
    }

    #[test]
    fn reads_the_servers_text_out_of_async_imaps_errors() {
        assert_eq!(
            answer_text(
                r#"code: None, info: Some("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")"#
            ),
            (
                Some("AUTHENTICATIONFAILED".into()),
                "Invalid credentials (Failure)".into()
            )
        );
        assert_eq!(
            answer_text(r#"code: Some(TryCreate), info: Some("Mailbox doesn't exist: \"Junk\"")"#),
            (
                Some("TRYCREATE".into()),
                "Mailbox doesn't exist: \"Junk\"".into()
            )
        );
        assert_eq!(
            answer_text("code: None, info: Some(\"Gr\u{fc}\u{df}e \\u{1f600}\")"),
            (None, "Grüße 😀".into())
        );
        assert_eq!(
            answer_text("code: None, info: None"),
            (None, "code: None, info: None".into())
        );
        assert_eq!(
            answer_text(
                r#"outcome: Outcome { code: None, information: Some("[NONEXISTENT] No such folder") }"#
            ),
            (Some("NONEXISTENT".into()), "No such folder".into())
        );
        assert_eq!(
            answer_text(r#"outcome: Outcome { code: Some(TryCreate), information: Some("No") }"#),
            (Some("TRYCREATE".into()), "No".into())
        );
    }

    #[test]
    fn tells_answers_apart_by_their_code() {
        let error = MailServerError::from(async_imap::error::Error::No(
            r#"code: None, info: Some("[NONEXISTENT] Unknown Mailbox: Foo")"#.into(),
        ));
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(error.message, "Unknown Mailbox: Foo");
        let error = MailServerError::from(async_imap::error::Error::No(
            r#"code: None, info: Some("[ALREADYEXISTS] Mailbox already exists")"#.into(),
        ));
        assert_eq!(error.kind, ErrorKind::Exists);
        let error = MailServerError::from(async_imap::error::Error::Bad(
            r#"code: None, info: Some("Error in IMAP command")"#.into(),
        ));
        assert_eq!(error.kind, ErrorKind::Server);
        assert_eq!(
            MailServerError::from(async_imap::error::Error::ConnectionLost).kind,
            ErrorKind::Unreachable
        );
    }
}
