//! What's kept about an IMAP/SMTP account (the `imap.vault` entry), what
//! the UI sends to add one, and what it's told about it: the shapes of
//! `src/accounts/mailServer.ts`.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::oauth::providers::Client;

/// How a server is reached: TLS from the start, or STARTTLS (required).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    Tls,
    Starttls,
}

/// A server's address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailServer {
    pub host: String,
    pub port: u16,
    pub security: Security,
}

/// Where an account's mail is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailServerSettings {
    pub imap: MailServer,
    pub smtp: MailServer,
    /// The login name (often the address).
    pub username: String,
}

/// Providers whose OAuth sign-in action0 knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Yahoo,
    Aol,
}

/// How an account signs in, with its secret.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImapAuth {
    Password {
        password: String,
    },
    /// A Yahoo/AOL sign-in: the app's registration and the (rotating)
    /// refresh token. Access tokens stay in memory.
    #[serde(rename = "oauth")]
    OAuth {
        provider: OAuthProvider,
        client: Client,
        refresh_token: String,
    },
}

/// Never shows the secrets (in case it ends up in a log).
impl fmt::Debug for ImapAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Password { … }"),
            Self::OAuth {
                provider, client, ..
            } => write!(
                f,
                "OAuth {{ provider: {provider:?}, client: {} }}",
                client.id
            ),
        }
    }
}

/// An account as kept in `imap.vault`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapAccount {
    pub address: String,
    /// The name mail goes out with.
    pub name: String,
    pub settings: MailServerSettings,
    pub auth: ImapAuth,
    /// The SHA-256 of a certificate the user chose to trust (upper-case
    /// hex, colon-separated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<String>,
    /// The SMTP server's `SIZE`, if it says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// The filter server (ManageSieve), once found or chosen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sieve: Option<SieveServer>,
}

/// An account's filter server (ManageSieve), as the UI gets it too
/// (`SieveServerInfo` in `src/providers/sieve/bridge.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SieveServer {
    pub host: String,
    pub port: u16,
    /// Its Sieve extensions as of the last login, lower case.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// The user entered it, rather than it being found.
    #[serde(default)]
    pub chosen: bool,
}

/// The account id of an address: `imap:<lower-case address>`.
pub fn account_key(address: &str) -> String {
    format!("imap:{}", address.trim().to_lowercase())
}

impl ImapAccount {
    pub fn key(&self) -> String {
        account_key(&self.address)
    }

    /// What the UI is told about it.
    pub fn info(&self) -> AccountInfo {
        AccountInfo {
            key: self.key(),
            address: self.address.clone(),
            name: self.name.clone(),
            settings: self.settings.clone(),
            sign_in: match &self.auth {
                ImapAuth::Password { .. } => SignIn::Password,
                ImapAuth::OAuth {
                    provider: OAuthProvider::Yahoo,
                    ..
                } => SignIn::Yahoo,
                ImapAuth::OAuth {
                    provider: OAuthProvider::Aol,
                    ..
                } => SignIn::Aol,
            },
            max_bytes: self.max_bytes,
            pinned: self.pinned.is_some(),
        }
    }
}

/// How an account signs in, without secrets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignIn {
    Password,
    Yahoo,
    Aol,
}

/// A kept account, as the UI knows it (`MailServerAccountInfo`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub key: String,
    pub address: String,
    pub name: String,
    pub settings: MailServerSettings,
    pub sign_in: SignIn,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    pub pinned: bool,
}

/// How a new account signs in (`MailServerCredentials`).
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum Credentials {
    Password {
        password: String,
    },
    OAuth {
        oauth: OAuthProvider,
        client: Client,
    },
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Password { … }"),
            Self::OAuth { oauth, .. } => write!(f, "OAuth {{ {oauth:?} }}"),
        }
    }
}

/// What adding an account needs (`MailServerSetup`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub address: String,
    #[serde(default)]
    pub name: String,
    pub settings: MailServerSettings,
    pub credentials: Credentials,
    /// The fingerprint of a certificate the user chose to trust.
    #[serde(default)]
    pub trust: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> MailServerSettings {
        MailServerSettings {
            imap: MailServer {
                host: "imap.gmx.net".into(),
                port: 993,
                security: Security::Tls,
            },
            smtp: MailServer {
                host: "mail.gmx.net".into(),
                port: 587,
                security: Security::Starttls,
            },
            username: "max@gmx.at".into(),
        }
    }

    #[test]
    fn reads_the_setup_the_ui_sends() {
        let setup: Setup = serde_json::from_value(serde_json::json!({
            "address": "Max@GMX.at",
            "name": "Max",
            "settings": {
                "imap": {"host": "imap.gmx.net", "port": 993, "security": "tls"},
                "smtp": {"host": "mail.gmx.net", "port": 587, "security": "starttls"},
                "username": "max@gmx.at"
            },
            "credentials": {"password": "secret"},
            "trust": "AB:CD"
        }))
        .unwrap();
        assert_eq!(setup.settings, settings());
        assert!(
            matches!(setup.credentials, Credentials::Password { ref password } if password == "secret")
        );
        assert_eq!(account_key(&setup.address), "imap:max@gmx.at");
        assert!(!format!("{setup:?}").contains("secret"));

        let setup: Setup = serde_json::from_value(serde_json::json!({
            "address": "max@yahoo.com",
            "name": "",
            "settings": settings(),
            "credentials": {"oauth": "yahoo", "client": {"id": "dj0y", "secret": "s"}}
        }))
        .unwrap();
        let Credentials::OAuth { oauth, client } = setup.credentials else {
            panic!("not oauth");
        };
        assert_eq!(oauth, OAuthProvider::Yahoo);
        assert_eq!(client.secret.as_deref(), Some("s"));
        assert_eq!(setup.trust, None);
    }

    #[test]
    fn tells_the_ui_no_secrets() {
        let account = ImapAccount {
            address: "max@yahoo.com".into(),
            name: "Max".into(),
            settings: settings(),
            auth: ImapAuth::OAuth {
                provider: OAuthProvider::Yahoo,
                client: Client {
                    id: "dj0y".into(),
                    secret: None,
                },
                refresh_token: "refresh-secret".into(),
            },
            pinned: Some("AB".into()),
            max_bytes: None,
            sieve: None,
        };
        let json = serde_json::to_value(account.info()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "key": "imap:max@yahoo.com",
                "address": "max@yahoo.com",
                "name": "Max",
                "settings": settings(),
                "signIn": "yahoo",
                "pinned": true
            })
        );
        assert!(!format!("{account:?}").contains("refresh-secret"));
        // The vault keeps it tagged, and reads it back.
        let kept = serde_json::to_value(&account).unwrap();
        assert_eq!(kept["auth"]["type"], "oauth");
        assert_eq!(kept["auth"]["refreshToken"], "refresh-secret");
        assert_eq!(
            serde_json::from_value::<ImapAccount>(kept).unwrap(),
            account
        );
    }
}
