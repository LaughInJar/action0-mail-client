//! Calendar servers (CalDAV) in the desktop and Android apps. The UI's
//! contract is `src/accounts/calendarServer.ts` (finding and connecting
//! servers) and `src/providers/caldav/bridge.ts` (requests); every JSON
//! shape here matches those files.
//!
//! The DAV and iCalendar work is the UI's (`CaldavCalendarProvider`); this
//! side keeps the logins and carries the requests:
//!
//! - `discover.rs`: where an address's calendar server may be (a table of
//!   providers, DNS SRV/TXT on the desktop, `/.well-known/caldav`, the mail
//!   server).
//! - `http.rs`: one request with the login, redirects followed only to the
//!   server's own hosts, failures as [`MailServerError`]s; and the walk from
//!   an address to the principal, the calendar home, scheduling and the
//!   address book home (CardDAV, on the principal or at the provider's own
//!   contacts server, whose host then joins the server's hosts).
//! - `dav.rs`: the little XML that walk needs.
//!
//! A login lives only in `caldav.vault` (encrypted with the accounts' key),
//! or is the mail account's own (`imap.vault`); it's only ever sent to the
//! hosts the server was found on, never handed to the UI.

pub mod dav;
pub mod discover;
pub mod http;

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::imap::tls::{self, Seen};
use crate::imap::{Imap, MailServerError, ServerRole};
use crate::oauth::pkce::random_token;
use crate::vault::{LazyVault, Vault};

pub use discover::Candidate;
use http::{Answer, Authorizer, Outgoing};

/// The header with a request's metadata (percent-encoded JSON).
pub const REQUEST_HEADER: &str = "x-a0-caldav";

/// How a calendar server is signed in to.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Login {
    /// The mail account's own login (password or Yahoo/AOL sign-in).
    SameAsMail,
    Password {
        username: String,
        password: String,
    },
}

/// Never shows the password (in case it ends up in a log).
impl fmt::Debug for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SameAsMail => f.write_str("SameAsMail"),
            Self::Password { username, .. } => write!(f, "Password {{ username: {username}, … }}"),
        }
    }
}

/// A calendar server as kept in `caldav.vault`, by its source key
/// (`imap:<address>` or `caldav:<id>`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarServer {
    /// A calendar-only server's name; a mail account's address.
    pub label: String,
    /// The user's DAV principal.
    pub principal: String,
    /// The calendar home (`calendar-home-set`).
    pub home: String,
    /// The user's calendar address, without `mailto:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// The origins (`https://host:port`) the login may be sent to.
    pub hosts: Vec<String>,
    pub login: Login,
    /// The SHA-256 of a certificate the user chose to trust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<String>,
    /// The server schedules itself (RFC 6638, `calendar-auto-schedule`).
    pub scheduling: bool,
    /// The address book home (CardDAV `addressbook-home-set`), if the
    /// login has address books.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contacts: Option<String>,
    /// Address books were looked for (servers set up before contacts
    /// weren't: [`Caldav::find_contacts`] does it once).
    #[serde(default)]
    pub contacts_checked: bool,
}

impl CalendarServer {
    /// What the UI is told about it (`CalendarServerInfo`).
    pub fn info(&self, key: &str) -> Info {
        Info {
            key: key.to_string(),
            label: self.label.clone(),
            home: self.home.clone(),
            principal: self.principal.clone(),
            address: self.address.clone(),
            username: match &self.login {
                Login::SameAsMail => String::new(),
                Login::Password { username, .. } => username.clone(),
            },
            same_as_mail: self.login == Login::SameAsMail,
            scheduling: self.scheduling,
            pinned: self.pinned.is_some(),
            contacts: self.contacts.clone(),
            contacts_checked: self.contacts_checked,
        }
    }

    /// Adds origins the login may go to.
    fn allow(&mut self, hosts: &[String]) {
        for host in hosts {
            if !self.hosts.contains(host) {
                self.hosts.push(host.clone());
            }
        }
    }
}

/// A connected server, as the UI knows it (`CalendarServerInfo`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub key: String,
    pub label: String,
    pub home: String,
    pub principal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub username: String,
    pub same_as_mail: bool,
    pub scheduling: bool,
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contacts: Option<String>,
    pub contacts_checked: bool,
}

/// How the UI asks to sign in (`CalendarServerLogin`).
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum SetupLogin {
    Password {
        username: String,
        password: String,
    },
    SameAsMail {
        #[serde(rename = "sameAsMail")]
        #[allow(dead_code)]
        same_as_mail: bool,
    },
}

/// What connecting needs (`CalendarServerSetup`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    pub urls: Vec<String>,
    pub login: SetupLogin,
    #[serde(default)]
    pub trust: Option<String>,
}

/// What a request carries besides its body (the [`REQUEST_HEADER`]).
#[derive(Debug, Deserialize, PartialEq)]
pub struct RequestMeta {
    pub key: String,
    pub id: u32,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// What comes back besides the body.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// Where the answer came from, after redirects.
    pub url: String,
}

/// An HTTP client for one server: its TLS checks (with its pin) and what
/// their handshakes saw.
#[derive(Clone)]
struct Client {
    pin: Option<String>,
    http: reqwest::Client,
    seen: Seen,
}

/// The calendar servers: the vault, a client per server, and the requests
/// in flight (so the UI can abort them).
pub struct Caldav {
    vault: LazyVault<CalendarServer>,
    /// One change of the vault at a time.
    writing: Mutex<()>,
    clients: Mutex<HashMap<String, Client>>,
    running: Mutex<HashMap<u32, futures::future::AbortHandle>>,
}

impl Caldav {
    pub fn new(vault: LazyVault<CalendarServer>) -> Self {
        Self {
            vault,
            writing: Mutex::new(()),
            clients: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
        }
    }

    /// The vault (opened now if it isn't yet; on Android not from the main thread).
    pub fn vault(&self) -> &Vault<CalendarServer> {
        self.vault.get()
    }

    /// A kept server, or `notFound`.
    pub fn server(&self, key: &str) -> Result<CalendarServer, MailServerError> {
        self.vault().get(key).ok_or_else(|| {
            MailServerError::not_found("No calendar server is set up for this.")
                .on(ServerRole::Caldav)
        })
    }

    /// Forgets a server's login (and its client).
    pub fn remove(&self, key: &str) {
        let _writing = self.writing.lock().expect("caldav lock");
        self.vault().remove(key);
        self.clients.lock().expect("caldav lock").remove(key);
    }

    /// Forgets a server's trusted certificate; it's refused from now on.
    pub fn forget_certificate(&self, key: &str) -> Result<(), MailServerError> {
        let _writing = self.writing.lock().expect("caldav lock");
        let mut server = self.server(key)?;
        server.pinned = None;
        self.vault().put(key, server);
        self.clients.lock().expect("caldav lock").remove(key);
        Ok(())
    }

    /// The server's client, made with its pin (again if the pin changed).
    fn client(&self, key: &str, server: &CalendarServer) -> Result<Client, MailServerError> {
        let mut clients = self.clients.lock().expect("caldav lock");
        if let Some(client) = clients.get(key)
            && client.pin == server.pinned
        {
            return Ok(client.clone());
        }
        let (config, seen) = tls::client_config(server.pinned.as_deref())?;
        let client = Client {
            pin: server.pinned.clone(),
            http: http::client(config)?,
            seen,
        };
        clients.insert(key.to_string(), client.clone());
        Ok(client)
    }

    /// Finds the server's calendars with the login and, if that works,
    /// keeps the login (replacing one kept for the key).
    pub async fn connect(&self, imap: &Imap, setup: Setup) -> Result<Info, MailServerError> {
        let key = match setup.key.as_deref().map(str::trim) {
            Some(key) if key.starts_with("imap:") || key.starts_with("caldav:") => key.to_string(),
            Some(_) => return Err(MailServerError::server("That isn't a calendar source.")),
            None => format!("caldav:{}", random_token(9)),
        };
        let login = match setup.login {
            SetupLogin::Password { username, password } => Login::Password {
                username: username.trim().to_string(),
                password,
            },
            SetupLogin::SameAsMail { .. } => {
                if !key.starts_with("imap:") || imap.vault().get(&key).is_none() {
                    return Err(MailServerError::not_found(
                        "There's no mail account to share the login with.",
                    ));
                }
                Login::SameAsMail
            }
        };
        let kept = self.vault().get(&key);
        let pin = match setup.trust.as_deref() {
            Some(text) => Some(trusted(text)?),
            None => kept.and_then(|server| server.pinned),
        };
        let (config, seen) = tls::client_config(pin.as_deref())?;
        let http = http::client(config)?;
        let mut authorizer = Authorizer::new(imap, &key, &login);
        let found = http::find(&http, &seen, &setup.urls, &mut authorizer).await?;
        // Address books: on the same principal, else the provider's own
        // contacts server. Never in the way of the calendars.
        let contacts = match found.contacts.clone() {
            Some(home) => Some(http::FoundContacts {
                home,
                hosts: Vec::new(),
            }),
            None => {
                let candidates = contacts_candidates(&key, &login, &found.home);
                http::find_contacts(&http, &seen, None, &candidates, &mut authorizer).await
            }
        };

        let label = if let Some(address) = key.strip_prefix("imap:") {
            address.to_string()
        } else {
            setup
                .label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    url::Url::parse(&found.home)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_string))
                })
                .unwrap_or_default()
        };
        let mut server = CalendarServer {
            label,
            principal: found.principal,
            home: found.home,
            address: found.address,
            hosts: found.hosts,
            login,
            // Kept only if it was needed.
            pinned: pin.filter(|_| seen.used_pin()),
            scheduling: found.scheduling,
            contacts: None,
            contacts_checked: true,
        };
        if let Some(contacts) = contacts {
            server.allow(&contacts.hosts);
            server.contacts = Some(contacts.home);
        }
        {
            let _writing = self.writing.lock().expect("caldav lock");
            self.vault().put(&key, server.clone());
            self.clients.lock().expect("caldav lock").remove(&key);
        }
        Ok(server.info(&key))
    }

    /// Looks for the address books of a server set up before contacts were
    /// looked for: on its principal, then at its provider's contacts
    /// server. Keeps what was found (and that it was looked for, also when
    /// nothing was).
    pub async fn find_contacts(&self, imap: &Imap, key: &str) -> Result<Info, MailServerError> {
        let server = self.server(key)?;
        let client = self.client(key, &server)?;
        let mut authorizer = Authorizer::new(imap, key, &server.login);
        let principal = url::Url::parse(&server.principal).ok();
        let candidates = contacts_candidates(key, &server.login, &server.home);
        let found = http::find_contacts(
            &client.http,
            &client.seen,
            principal,
            &candidates,
            &mut authorizer,
        )
        .await;
        let _writing = self.writing.lock().expect("caldav lock");
        // As it is now: it may have changed meanwhile.
        let mut server = self.server(key)?;
        if let Some(found) = found {
            server.allow(&found.hosts);
            server.contacts = Some(found.home);
        }
        server.contacts_checked = true;
        self.vault().put(key, server.clone());
        Ok(server.info(key))
    }

    /// One request of the UI to the server of `meta.key` (see the module
    /// docs): only to its hosts, with its login; every HTTP status is an
    /// answer.
    pub async fn request(
        &self,
        imap: &Imap,
        meta: &RequestMeta,
        body: Vec<u8>,
    ) -> Result<Answer, MailServerError> {
        let server = self.server(&meta.key)?;
        let url = url::Url::parse(&meta.url)
            .map_err(|_| MailServerError::server("Not a web address.").on(ServerRole::Caldav))?;
        if !http::allowed(&url, &server.hosts) {
            return Err(MailServerError::server(format!(
                "This calendar's login is only sent to {}.",
                server.hosts.join(", ")
            ))
            .on(ServerRole::Caldav));
        }
        let method = reqwest::Method::from_bytes(meta.method.as_bytes())
            .map_err(|_| MailServerError::server("Bad method.").on(ServerRole::Caldav))?;
        let client = self.client(&meta.key, &server)?;
        let outgoing = Outgoing {
            method,
            url,
            headers: meta.headers.clone(),
            body,
        };
        let mut authorizer = Authorizer::new(imap, &meta.key, &server.login);
        let hosts = server.hosts.clone();
        let follow = |next: &url::Url| http::allowed(next, &hosts);
        let authorization = authorizer.header().await?;
        let answer = http::send(
            &client.http,
            &client.seen,
            &outgoing,
            Some(&authorization),
            &follow,
        )
        .await?;
        if answer.status == 401 && authorizer.renew().await? {
            let authorization = authorizer.header().await?;
            return http::send(
                &client.http,
                &client.seen,
                &outgoing,
                Some(&authorization),
                &follow,
            )
            .await;
        }
        Ok(answer)
    }
}

/// Where a server's address books may be when its principal names none:
/// the contacts server of its provider, known by the mail account's
/// address, the login's address, or the calendar server's host.
fn contacts_candidates(key: &str, login: &Login, home: &str) -> Vec<String> {
    let address = key.strip_prefix("imap:").or(match login {
        Login::Password { username, .. } if username.contains('@') => Some(username.as_str()),
        _ => None,
    });
    let by_address = address
        .and_then(|address| address.rsplit_once('@'))
        .and_then(|(_, domain)| discover::contacts_for_domain(domain));
    let by_host = || {
        url::Url::parse(home)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .and_then(|host| discover::contacts_for_calendar_host(&host))
    };
    by_address
        .or_else(by_host)
        .map(str::to_string)
        .into_iter()
        .collect()
}

/// A certificate fingerprint the user chose, as it's kept.
fn trusted(text: &str) -> Result<String, MailServerError> {
    tls::parse_fingerprint(text)
        .map(|bytes| tls::format_fingerprint(&bytes))
        .ok_or_else(|| {
            MailServerError::tls("The trusted certificate isn't a SHA-256 fingerprint.")
                .on(ServerRole::Caldav)
        })
}

/// `Basic …` for a username and password.
pub fn basic_authorization(username: &str, password: &str) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    )
}

/// Reads a request's metadata from its header.
pub fn parse_meta(header: &str) -> Result<RequestMeta, MailServerError> {
    let json = percent_decode_str(header)
        .decode_utf8()
        .map_err(|_| MailServerError::server("The request header isn't UTF-8."))?;
    serde_json::from_str(&json)
        .map_err(|error| MailServerError::server(format!("Bad request header: {error}")))
}

/// `[u32 big-endian meta length][meta JSON][body]`.
pub fn frame(meta: &ResponseMeta, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(meta).expect("response metadata serializes");
    let mut out = Vec::with_capacity(4 + json.len() + body.len());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

/// Where an address's calendar server may be, best first.
#[tauri::command]
pub async fn caldav_discover(
    address: String,
    mail_host: Option<String>,
) -> Result<Vec<Candidate>, MailServerError> {
    discover::discover(&address, mail_host.as_deref()).await
}

/// Signs in at the first address that is a calendar server and keeps the login.
#[tauri::command]
pub async fn caldav_connect(
    imap: State<'_, Imap>,
    caldav: State<'_, Caldav>,
    setup: Setup,
) -> Result<Info, MailServerError> {
    caldav.connect(&imap, setup).await
}

/// The connected servers. (Async: on Android, opening the vault asks the
/// Kotlin side, which mustn't be waited for on the main thread.)
#[tauri::command]
pub async fn caldav_servers(caldav: State<'_, Caldav>) -> Result<Vec<Info>, MailServerError> {
    Ok(caldav
        .vault()
        .all()
        .iter()
        .map(|(key, server)| server.info(key))
        .collect())
}

/// Forgets a server's login.
#[tauri::command]
pub async fn caldav_remove(caldav: State<'_, Caldav>, key: String) -> Result<(), MailServerError> {
    caldav.remove(&key);
    Ok(())
}

/// Looks for the address books of a server set up before contacts were.
#[tauri::command]
pub async fn caldav_find_contacts(
    imap: State<'_, Imap>,
    caldav: State<'_, Caldav>,
    key: String,
) -> Result<Info, MailServerError> {
    caldav.find_contacts(&imap, &key).await
}

/// Forgets a server's trusted certificate.
#[tauri::command]
pub async fn caldav_forget_certificate(
    caldav: State<'_, Caldav>,
    key: String,
) -> Result<(), MailServerError> {
    caldav.forget_certificate(&key)
}

/// One request to a calendar server: the body is the raw invoke payload,
/// the rest is in the [`REQUEST_HEADER`]; the answer is framed like
/// `net_fetch`'s, with the final URL in its metadata.
#[tauri::command]
pub async fn caldav_request(
    request: Request<'_>,
    imap: State<'_, Imap>,
    caldav: State<'_, Caldav>,
) -> Result<Response, MailServerError> {
    let header = request
        .headers()
        .get(REQUEST_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| MailServerError::server("The request header is missing."))?;
    let meta = parse_meta(header)?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };
    let (work, abort) = futures::future::abortable(caldav.request(&imap, &meta, body));
    caldav
        .running
        .lock()
        .expect("caldav lock")
        .insert(meta.id, abort);
    let result = work.await;
    caldav.running.lock().expect("caldav lock").remove(&meta.id);
    match result {
        Ok(Ok(answer)) => Ok(Response::new(frame(&answer.meta(), &answer.body))),
        Ok(Err(error)) => Err(error),
        Err(futures::future::Aborted) => Err(MailServerError::server("aborted")),
    }
}

/// Aborts a request the UI no longer wants.
#[tauri::command]
pub fn caldav_abort(caldav: State<'_, Caldav>, id: u32) {
    if let Some(handle) = caldav.running.lock().expect("caldav lock").remove(&id) {
        handle.abort();
    }
}

impl Answer {
    /// The framed metadata.
    pub fn meta(&self) -> ResponseMeta {
        ResponseMeta {
            status: self.status,
            status_text: self.status_text.clone(),
            headers: self.headers.clone(),
            url: self.url.to_string(),
        }
    }
}

#[cfg(test)]
mod tests;
