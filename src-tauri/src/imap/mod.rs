//! IMAP/SMTP accounts ("other mail server") in the desktop and Android
//! apps. The UI's contract is `src/accounts/mailServer.ts` (adding
//! accounts) and `src/providers/imap/bridge.ts` (mail); every JSON shape
//! here matches those files.
//!
//! - `account.rs`: the `imap.vault` entry (settings, password or Yahoo/AOL
//!   refresh token, pinned certificate, SMTP size limit) and the shapes the
//!   UI sends and gets.
//! - `tls.rs`: the system's certificate checks plus one pinned certificate
//!   per account; refused certificates come back with their details.
//! - `session.rs`: connecting (TLS, or STARTTLS that's required), logging
//!   in, ID, ENABLE; [`ImapSession`] with the capabilities and the open folder.
//! - `pool.rs`: up to two worker sessions per account.
//! - `smtp.rs`: sending (our own small submission client).
//! - `discover.rs`: finding an address's settings (autoconfig, ISPDB, MX).
//! - `oauth.rs`: Yahoo/AOL sign-in.
//!
//! The mail operations (`imap_call`, `imap_bytes`, `imap_append`):
//!
//! - `model.rs`: the JSON of `bridge.ts`.
//! - `ids.rs`: folder and message ids, and where each message is now.
//! - `proto.rs`: commands with literals, read answer by answer.
//! - `folders.rs`: LIST, roles, the tree and the views.
//! - `search.rs`: the search field as IMAP search keys.
//! - `list.rs`: lists (snapshots of UIDs, pages of rows, snippets).
//! - `threads.rs`: conversations.
//! - `read.rs` and `parse.rs`: finding and reading whole messages.
//! - `write.rs`: flags, moving, deleting, folders, APPEND.
//! - `sync.rs`: what changed since a token.
//! - `idle.rs`: IDLE on the Inbox (desktop).
//! - `state.rs`: what's kept in memory per account; `calls.rs`: the commands' work.
//!
//! Secrets live only in the vault (encrypted, with the accounts' key) and
//! access tokens in memory; neither reaches the UI or a log. No mail is
//! ever written to disk.
//!
//! # Building on it (mail operations, sync, IDLE)
//!
//! - [`Imap::session`]`(key)` gives a [`PooledSession`]: a logged-in session
//!   for one caller (it waits while both workers are busy). It derefs to
//!   [`ImapSession`], which derefs to `async_imap::Session<Stream>`, so
//!   async-imap's commands (`uid_fetch`, `uid_search`, `list`, `status`,
//!   `uid_mv`, `append`, `run_command_and_check_ok`, …) work on it directly,
//!   and `?` turns their errors into [`MailServerError`]s (NO/BAD:
//!   `server` with the server's text; `[NONEXISTENT]`/`[TRYCREATE]`:
//!   `notFound`; `[ALREADYEXISTS]`: `exists`; I/O: `unreachable`).
//!   Dropping the guard puts the session back; call
//!   [`PooledSession::discard`] after a connection error, or when leaving
//!   it in a state the next caller shouldn't get.
//! - [`Imap::run`]`(key, |s| Box::pin(op(s)))` does the same, and if a kept
//!   session turns out broken (`unreachable`, e.g. after the computer slept),
//!   runs the operation once more on a new connection. Only for operations
//!   that may run twice (not APPEND).
//! - [`ImapSession`] keeps `capabilities` (`has("MOVE")`, `auth("PLAIN")`),
//!   `enabled` (what ENABLE turned on: `CONDSTORE`, `QRESYNC`,
//!   `UTF8=ACCEPT`) and `selected` (the open folder: its path, read-only or
//!   not, and async-imap's `Mailbox` with UIDVALIDITY, UIDNEXT,
//!   HIGHESTMODSEQ as of opening). [`ImapSession::open_folder`]`(path,
//!   Access::ReadOnly | ReadWrite)` sends EXAMINE/SELECT only if needed;
//!   [`ImapSession::reopen_folder`] always does. Code that selects or closes
//!   with raw commands keeps `selected` right itself.
//! - Write operations against `&mut ImapSession<S>` with `S: Transport`
//!   (or plain `&mut ImapSession`, whose `Stream` is boxed): tests make one
//!   with [`session::login_on`] over `testing::scripted` (a scripted server
//!   on `tokio::io::duplex`; see the tests in `session.rs` and `pool.rs`).
//! - IDLE: [`Imap::dedicated_session`] opens a session outside the pool,
//!   owned by the caller ([`ImapSession::into_inner`] gives async-imap's
//!   session for `idle()`). [`Imap::close`] drops an account's pooled
//!   sessions; `imap_remove` (in this file) is where IDLE should stop too.
//! - Android's background check works without the `Imap` state:
//!   [`session::connect`] with a [`tls::Connector`] for the account's pin,
//!   and [`renew_access`] for a Yahoo/AOL token (keep the refresh token it
//!   may return, they rotate).
//! - `imap_append` reads its request like `imap_send`: [`header_json`] for
//!   the `x-a0-imap` header, [`raw_body`] for the message.

pub mod account;
mod calls;
pub mod discover;
pub mod error;
mod folders;
#[cfg(desktop)]
mod idle;
pub mod ids;
mod list;
mod model;
pub mod oauth;
mod parse;
pub mod pool;
mod proto;
mod read;
mod search;
pub mod session;
pub mod smtp;
mod state;
mod sync;
#[cfg(test)]
pub(crate) mod testing;
mod threads;
pub mod tls;
mod write;

#[cfg(test)]
mod live;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::oauth::loopback::{Loopback, PageTexts};
use crate::oauth::pkce::{Pkce, random_token};
use crate::oauth::providers::{Client, TokenResponse};
use crate::oauth::{
    AuthError, Callback, RENEW_BEFORE_MS, browser_round_trip, callback_code, now_ms, token_request,
};
use crate::vault::{LazyVault, Vault};

pub use account::{
    AccountInfo, Credentials, ImapAccount, ImapAuth, MailServer, MailServerSettings, OAuthProvider,
    Security, Setup, account_key,
};
pub use error::{ErrorKind, MailServerCertificate, MailServerError, ServerRole};
pub use pool::PooledSession;
pub use read::{InboxMark, Unread, new_unread};
pub use session::{Access, Capabilities, ImapSession, Login, Secret, Selected, Stream, Transport};
pub use smtp::Envelope;

/// The header with a raw-body request's other arguments (percent-encoded JSON).
pub const REQUEST_HEADER: &str = "x-a0-imap";

/// An access token in memory.
struct Token {
    access: String,
    expires_at: u64,
}

/// A password or access token, owned.
enum Credential {
    Password(String),
    Token(String),
}

impl Credential {
    fn secret(&self) -> Secret<'_> {
        match self {
            Self::Password(password) => Secret::Password(password),
            Self::Token(token) => Secret::Bearer(token),
        }
    }
}

/// The IMAP/SMTP accounts: the vault, each account's connections, Yahoo/AOL
/// access tokens and the sign-in waiting for the browser.
pub struct Imap {
    http: reqwest::Client,
    vault: LazyVault<ImapAccount>,
    /// One change of a vault entry at a time (read, change, write).
    writing: Mutex<()>,
    pools: Mutex<HashMap<String, Arc<pool::Pool>>>,
    tokens: Mutex<HashMap<String, Token>>,
    /// One renewal at a time (refresh tokens rotate).
    renewing: tokio::sync::Mutex<()>,
    signing_in: Mutex<Option<oneshot::Sender<()>>>,
    /// Where Yahoo/AOL tokens come from (tests: a local server).
    token_endpoint: fn(OAuthProvider) -> String,
    /// What's kept in memory about each account's mail.
    mail: state::Mail,
    /// IDLE on each account's Inbox.
    #[cfg(desktop)]
    idlers: idle::Idlers,
}

impl Imap {
    pub fn new(http: reqwest::Client, vault: LazyVault<ImapAccount>) -> Self {
        Self {
            http,
            vault,
            writing: Mutex::new(()),
            pools: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            renewing: tokio::sync::Mutex::new(()),
            signing_in: Mutex::new(None),
            token_endpoint: OAuthProvider::token_endpoint,
            mail: state::Mail::default(),
            #[cfg(desktop)]
            idlers: idle::Idlers::default(),
        }
    }

    /// The vault (opened now if it isn't yet; on Android not from the main thread).
    pub fn vault(&self) -> &Vault<ImapAccount> {
        self.vault.get()
    }

    /// A kept account, or `notFound`.
    pub fn account(&self, key: &str) -> Result<ImapAccount, MailServerError> {
        self.vault()
            .get(key)
            .ok_or_else(|| MailServerError::not_found("The account isn't known (any more)."))
    }

    /// Changes a kept account.
    fn update(
        &self,
        key: &str,
        change: impl FnOnce(&mut ImapAccount),
    ) -> Result<ImapAccount, MailServerError> {
        let _writing = self.writing.lock().expect("imap lock");
        let mut account = self.account(key)?;
        change(&mut account);
        self.vault().put(key, account.clone());
        Ok(account)
    }

    fn pool(&self, key: &str) -> Arc<pool::Pool> {
        self.pools
            .lock()
            .expect("imap lock")
            .entry(key.to_string())
            .or_insert_with(pool::Pool::new)
            .clone()
    }

    /// A logged-in session of the account, for one caller (see the module docs).
    pub async fn session(&self, key: &str) -> Result<PooledSession, MailServerError> {
        self.pool(key).get(|| self.open(key), false).await
    }

    /// Runs `op` on a session of the account; once more on a new connection
    /// if a kept session turns out broken. Only for operations that may run
    /// twice.
    pub async fn run<T, F>(&self, key: &str, mut op: F) -> Result<T, MailServerError>
    where
        F: for<'s> FnMut(&'s mut ImapSession) -> BoxFuture<'s, Result<T, MailServerError>>,
    {
        let pool = self.pool(key);
        let mut session = pool.get(|| self.open(key), false).await?;
        match op(&mut session).await {
            Err(error) if error.is_connection() => {
                let reused = session.reused();
                session.discard();
                if !reused {
                    return Err(error);
                }
                let mut session = pool.get(|| self.open(key), true).await?;
                let result = op(&mut session).await;
                if result.as_ref().is_err_and(MailServerError::is_connection) {
                    session.discard();
                }
                result
            }
            result => result,
        }
    }

    /// A new session outside the pool, owned by the caller (IDLE). Refused
    /// at once after a refused login, like the pool's.
    pub async fn dedicated_session(&self, key: &str) -> Result<ImapSession, MailServerError> {
        let pool = self.pool(key);
        if let Some(error) = pool.refused() {
            return Err(error);
        }
        let result = self.open(key).await;
        if let Err(error) = &result
            && error.kind == ErrorKind::Auth
        {
            pool.refuse(error.clone());
        }
        result
    }

    /// Drops the account's kept sessions and its pool (a new one starts
    /// with the next call); sessions in use close when they're done.
    pub fn close(&self, key: &str) {
        if let Some(pool) = self.pools.lock().expect("imap lock").remove(key) {
            pool.close();
        }
    }

    /// Connects and logs in with the account's settings. A Yahoo/AOL token
    /// that's refused is renewed once (it may have been revoked early).
    async fn open(&self, key: &str) -> Result<ImapSession, MailServerError> {
        let account = self.account(key)?;
        let (credential, renewed) = self.credential(key, false).await?;
        let connect = |credential: Credential| {
            let account = &account;
            async move {
                let tls = tls::Connector::new(account.pinned.as_deref())?;
                let login = Login {
                    server: &account.settings.imap,
                    username: &account.settings.username,
                    secret: credential.secret(),
                };
                session::connect(&login, &tls).await
            }
        };
        match connect(credential).await {
            Err(error) if error.kind == ErrorKind::Auth && !renewed && is_oauth(&account) => {
                let (credential, _) = self.credential(key, true).await?;
                connect(credential).await
            }
            result => result,
        }
    }

    /// The account's password or a fresh access token (renewed if it runs
    /// out soon, or if `renew`); and whether it was just renewed.
    async fn credential(
        &self,
        key: &str,
        renew: bool,
    ) -> Result<(Credential, bool), MailServerError> {
        if let ImapAuth::Password { password } = self.account(key)?.auth {
            return Ok((Credential::Password(password), false));
        }
        if !renew && let Some(token) = self.fresh_token(key) {
            return Ok((Credential::Token(token), false));
        }
        let _renewing = self.renewing.lock().await;
        // Someone else may have renewed it meanwhile.
        if !renew && let Some(token) = self.fresh_token(key) {
            return Ok((Credential::Token(token), false));
        }
        // Read again: the refresh token may have rotated meanwhile.
        let account = self.account(key)?;
        let tokens = renew_at(&self.http, &account, self.token_endpoint).await?;
        self.keep_token(key, &tokens);
        if let Some(rotated) = tokens.refresh_token {
            self.update(key, |account| {
                if let ImapAuth::OAuth { refresh_token, .. } = &mut account.auth {
                    *refresh_token = rotated;
                }
            })?;
        }
        Ok((Credential::Token(tokens.access_token), true))
    }

    fn fresh_token(&self, key: &str) -> Option<String> {
        let tokens = self.tokens.lock().expect("imap lock");
        let token = tokens.get(key)?;
        (token.expires_at > now_ms() + RENEW_BEFORE_MS).then(|| token.access.clone())
    }

    fn keep_token(&self, key: &str, tokens: &TokenResponse) {
        self.tokens.lock().expect("imap lock").insert(
            key.to_string(),
            Token {
                access: tokens.access_token.clone(),
                expires_at: now_ms() + tokens.expires_in.unwrap_or(3600) * 1000,
            },
        );
    }

    /// Forgets the account's connections and access token.
    fn forget(&self, key: &str) {
        self.close(key);
        self.tokens.lock().expect("imap lock").remove(key);
    }

    /// Sends a mail over the account's SMTP server.
    pub async fn send(
        &self,
        key: &str,
        envelope: &Envelope,
        message: &[u8],
    ) -> Result<(), MailServerError> {
        let account = self.account(key)?;
        let (credential, renewed) = self.credential(key, false).await?;
        let send = |credential: Credential| {
            let account = &account;
            async move {
                let tls = tls::Connector::new(account.pinned.as_deref())?;
                let login = Login {
                    server: &account.settings.smtp,
                    username: &account.settings.username,
                    secret: credential.secret(),
                };
                smtp::send(&login, &tls, envelope, message).await
            }
        };
        match send(credential).await {
            Err(error) if error.kind == ErrorKind::Auth && !renewed && is_oauth(&account) => {
                let (credential, _) = self.credential(key, true).await?;
                send(credential).await
            }
            result => result,
        }
    }

    /// Starts a sign-in: one still waiting for the browser is cancelled.
    fn begin_sign_in(&self) -> oneshot::Receiver<()> {
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = self.signing_in.lock().expect("imap lock").replace(cancel) {
            let _ = previous.send(());
        }
        cancelled
    }

    /// Signs in at Yahoo/AOL in the browser: the tokens (with a refresh token).
    async fn sign_in(
        &self,
        app: &AppHandle,
        provider: OAuthProvider,
        client: &Client,
        page: &PageTexts,
    ) -> Result<TokenResponse, MailServerError> {
        let cancelled = self.begin_sign_in();
        let loopback = Loopback::bind()
            .await
            .map_err(|e| sign_in_error(AuthError::Network(e.to_string())))?;
        let redirect_uri = oauth::redirect_uri(loopback.port);
        let pkce = Pkce::new();
        let state = random_token(16);
        let url = provider.authorize_url(client, &redirect_uri, &pkce.challenge, &state);
        let callback = Callback {
            path: oauth::CALLBACK_PATH,
            required: "state",
            page,
            link: oauth::AUTH_TAB_LINK,
        };
        let params = browser_round_trip(app, &loopback, &url, &callback, cancelled)
            .await
            .map_err(sign_in_error)?;
        let code = callback_code(&params, Some(&state)).map_err(sign_in_error)?;
        let form = provider.code_form(client, &code, &pkce.verifier, &redirect_uri);
        let tokens = token_request(&self.http, &(self.token_endpoint)(provider), &form)
            .await
            .map_err(sign_in_error)?;
        if tokens.refresh_token.is_none() {
            return Err(MailServerError::new(
                ErrorKind::OAuth,
                "No refresh token came back from the sign-in.",
            ));
        }
        Ok(tokens)
    }

    /// Adds (or replaces) an account: signs in if it's Yahoo/AOL, logs in
    /// to IMAP and SMTP, then keeps it (the IMAP session goes to its pool).
    async fn add(
        &self,
        app: &AppHandle,
        setup: Setup,
        page: &PageTexts,
    ) -> Result<AccountInfo, MailServerError> {
        let address = setup.address.trim().to_string();
        if discover::address_domain(&address).is_none() {
            return Err(MailServerError::server("That isn't an email address."));
        }
        let settings = setup.settings;
        for server in [&settings.imap, &settings.smtp] {
            if server.host.trim().is_empty() || server.port == 0 {
                return Err(MailServerError::unreachable(
                    "A server name or port is missing.",
                ));
            }
        }
        let trust = match setup.trust.as_deref() {
            Some(text) => Some(tls::format_fingerprint(
                &tls::parse_fingerprint(text).ok_or_else(|| {
                    MailServerError::tls("The trusted certificate isn't a SHA-256 fingerprint.")
                })?,
            )),
            None => None,
        };
        let (auth, tokens) = match setup.credentials {
            Credentials::Password { password } => (ImapAuth::Password { password }, None),
            Credentials::OAuth { oauth, client } => {
                let tokens = self.sign_in(app, oauth, &client, page).await?;
                let auth = ImapAuth::OAuth {
                    provider: oauth,
                    client,
                    refresh_token: tokens.refresh_token.clone().unwrap_or_default(),
                };
                (auth, Some(tokens))
            }
        };
        let credential = match (&auth, &tokens) {
            (_, Some(tokens)) => Credential::Token(tokens.access_token.clone()),
            (ImapAuth::Password { password }, None) => Credential::Password(password.clone()),
            (ImapAuth::OAuth { .. }, None) => unreachable!("a sign-in brings tokens"),
        };

        let imap_tls = tls::Connector::new(trust.as_deref())?;
        let imap_login = Login {
            server: &settings.imap,
            username: &settings.username,
            secret: credential.secret(),
        };
        let session = session::connect(&imap_login, &imap_tls)
            .await
            .map_err(|error| error.on(ServerRole::Imap))?;
        let smtp_tls = tls::Connector::new(trust.as_deref())?;
        let smtp_login = Login {
            server: &settings.smtp,
            ..imap_login
        };
        let max_bytes = smtp::check(&smtp_login, &smtp_tls)
            .await
            .map_err(|error| error.on(ServerRole::Smtp))?;

        let account = ImapAccount {
            address,
            name: setup.name.trim().to_string(),
            settings: settings.clone(),
            auth,
            // Kept only if it was needed.
            pinned: trust.filter(|_| imap_tls.used_pin() || smtp_tls.used_pin()),
            max_bytes,
        };
        let key = account.key();
        self.forget(&key);
        self.mail.forget(&key);
        {
            let _writing = self.writing.lock().expect("imap lock");
            self.vault().put(&key, account.clone());
        }
        if let Some(tokens) = &tokens {
            self.keep_token(&key, tokens);
        }
        self.pool(&key).keep(session);
        Ok(account.info())
    }

    /// Logs an account in again: with a new password, or (`None`) a new
    /// Yahoo/AOL sign-in. Kept only if the IMAP login works.
    async fn reconnect(
        &self,
        app: &AppHandle,
        key: &str,
        password: Option<String>,
        page: &PageTexts,
    ) -> Result<(), MailServerError> {
        let account = self.account(key)?;
        let (auth, tokens) = match (password, &account.auth) {
            (Some(password), _) => (ImapAuth::Password { password }, None),
            (
                None,
                ImapAuth::OAuth {
                    provider, client, ..
                },
            ) => {
                let tokens = self.sign_in(app, *provider, client, page).await?;
                let auth = ImapAuth::OAuth {
                    provider: *provider,
                    client: client.clone(),
                    refresh_token: tokens.refresh_token.clone().unwrap_or_default(),
                };
                (auth, Some(tokens))
            }
            (None, ImapAuth::Password { .. }) => {
                return Err(MailServerError::auth("A password is needed."));
            }
        };
        let credential = match (&auth, &tokens) {
            (_, Some(tokens)) => Credential::Token(tokens.access_token.clone()),
            (ImapAuth::Password { password }, None) => Credential::Password(password.clone()),
            (ImapAuth::OAuth { .. }, None) => unreachable!("a sign-in brings tokens"),
        };
        let tls = tls::Connector::new(account.pinned.as_deref())?;
        let login = Login {
            server: &account.settings.imap,
            username: &account.settings.username,
            secret: credential.secret(),
        };
        let session = session::connect(&login, &tls)
            .await
            .map_err(|error| error.on(ServerRole::Imap))?;
        self.forget(key);
        self.update(key, |account| account.auth = auth)?;
        if let Some(tokens) = &tokens {
            self.keep_token(key, tokens);
        }
        self.pool(key).keep(session);
        Ok(())
    }

    /// Forgets an account: its connections, token, what's kept in memory
    /// about its mail, and its vault entry.
    fn remove(&self, key: &str) {
        self.forget(key);
        self.mail.forget(key);
        let _writing = self.writing.lock().expect("imap lock");
        self.vault().remove(key);
    }

    /// Forgets an account's trusted certificate; it's refused from now on.
    fn forget_certificate(&self, key: &str) -> Result<(), MailServerError> {
        self.update(key, |account| account.pinned = None)?;
        self.close(key);
        Ok(())
    }
}

fn is_oauth(account: &ImapAccount) -> bool {
    matches!(account.auth, ImapAuth::OAuth { .. })
}

/// A failed Yahoo/AOL sign-in.
fn sign_in_error(error: AuthError) -> MailServerError {
    MailServerError::new(ErrorKind::OAuth, error.to_string())
}

/// A new access token for a Yahoo/AOL account (and maybe a new refresh
/// token, which then replaces the kept one). A refusal means signing in
/// again (`auth`); no answer is `unreachable`.
pub async fn renew_access(
    http: &reqwest::Client,
    account: &ImapAccount,
) -> Result<TokenResponse, MailServerError> {
    renew_at(http, account, OAuthProvider::token_endpoint).await
}

async fn renew_at(
    http: &reqwest::Client,
    account: &ImapAccount,
    endpoint: fn(OAuthProvider) -> String,
) -> Result<TokenResponse, MailServerError> {
    let ImapAuth::OAuth {
        provider,
        client,
        refresh_token,
    } = &account.auth
    else {
        return Err(MailServerError::auth(
            "The account signs in with a password.",
        ));
    };
    let form = provider.refresh_form(client, refresh_token);
    token_request(http, &endpoint(*provider), &form)
        .await
        .map_err(|error| match error {
            AuthError::Network(message) => MailServerError::unreachable(message),
            other => MailServerError::auth(format!("The sign-in has run out: {other}")),
        })
}

/// Reads a raw-body request's arguments from the [`REQUEST_HEADER`].
pub fn header_json<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, MailServerError> {
    let header = request
        .headers()
        .get(REQUEST_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| MailServerError::server("The request header is missing."))?;
    let json = percent_decode_str(header)
        .decode_utf8()
        .map_err(|_| MailServerError::server("The request header isn't UTF-8."))?;
    serde_json::from_str(&json)
        .map_err(|error| MailServerError::server(format!("Bad request header: {error}")))
}

/// A raw-body request's body.
pub fn raw_body(request: &Request<'_>) -> Vec<u8> {
    match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => Vec::new(),
    }
}

/// Looks up an address's server settings.
#[tauri::command]
pub async fn imap_discover(
    imap: State<'_, Imap>,
    address: String,
) -> Result<discover::Discovery, MailServerError> {
    discover::discover(&imap.http, &address).await
}

/// Logs in to IMAP and SMTP with the setup (signing in at Yahoo/AOL first)
/// and, if both work, keeps the account; a known one is replaced.
#[tauri::command]
pub async fn imap_connect(
    app: AppHandle,
    imap: State<'_, Imap>,
    setup: Setup,
    page: PageTexts,
) -> Result<AccountInfo, MailServerError> {
    let info = imap.add(&app, setup, &page).await?;
    #[cfg(desktop)]
    imap.idlers.start(&app, &info.key);
    Ok(info)
}

/// The kept accounts, and whether they outlast this run (keychain).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptAccounts {
    pub persistent: bool,
    pub accounts: Vec<AccountInfo>,
}

/// The accounts kept from earlier starts. (Async: on Android, opening the
/// vault asks the Kotlin side, which mustn't be waited for on the main thread.)
#[tauri::command]
pub async fn imap_accounts(imap: State<'_, Imap>) -> Result<KeptAccounts, MailServerError> {
    let vault = imap.vault();
    Ok(KeptAccounts {
        persistent: vault.persistent(),
        accounts: vault.all().values().map(ImapAccount::info).collect(),
    })
}

/// Logs an account in again: a new password (tried first), or a new
/// Yahoo/AOL sign-in without one.
#[tauri::command]
pub async fn imap_reconnect(
    app: AppHandle,
    imap: State<'_, Imap>,
    key: String,
    password: Option<String>,
    page: PageTexts,
) -> Result<(), MailServerError> {
    imap.reconnect(&app, &key, password, &page).await?;
    #[cfg(desktop)]
    imap.idlers.start(&app, &key);
    Ok(())
}

/// Forgets an account (and its trusted certificate), closing its connections.
#[tauri::command]
pub async fn imap_remove(imap: State<'_, Imap>, key: String) -> Result<(), MailServerError> {
    #[cfg(desktop)]
    imap.idlers.stop(&key);
    imap.remove(&key);
    Ok(())
}

/// Forgets an account's trusted certificate.
#[tauri::command]
pub async fn imap_forget_certificate(
    app: AppHandle,
    imap: State<'_, Imap>,
    key: String,
) -> Result<(), MailServerError> {
    imap.forget_certificate(&key)?;
    // IDLE's session trusted it too.
    #[cfg(desktop)]
    imap.idlers.start(&app, &key);
    #[cfg(not(desktop))]
    let _ = app;
    Ok(())
}

/// What `imap_send` gets besides the message.
#[derive(Debug, serde::Deserialize)]
struct SendMeta {
    key: String,
    from: String,
    to: Vec<String>,
}

/// Sends the message (the raw body) over SMTP; the envelope is in the
/// `x-a0-imap` header.
#[tauri::command]
pub async fn imap_send(request: Request<'_>, imap: State<'_, Imap>) -> Result<(), MailServerError> {
    let meta: SendMeta = header_json(&request)?;
    let envelope = Envelope {
        from: meta.from,
        to: meta.to,
    };
    imap.send(&meta.key, &envelope, &raw_body(&request)).await
}

/// One mail operation of `bridge.ts`'s `ImapCalls` (`name`), with its request.
#[tauri::command]
pub async fn imap_call(
    imap: State<'_, Imap>,
    key: String,
    name: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, MailServerError> {
    calls::call(&imap, &key, &name, request).await
}

/// A message as it is, or one part decoded, as raw bytes.
#[tauri::command]
pub async fn imap_bytes(
    imap: State<'_, Imap>,
    key: String,
    request: model::BytesRequest,
) -> Result<tauri::ipc::Response, MailServerError> {
    Ok(tauri::ipc::Response::new(
        calls::bytes(&imap, &key, request).await?,
    ))
}

/// What `imap_append` answers.
#[derive(Debug, Serialize)]
pub struct Appended {
    pub id: String,
}

/// Stores the message (the raw body) in a folder; `{key, mailboxId, flags}`
/// is in the `x-a0-imap` header.
#[tauri::command]
pub async fn imap_append(
    request: Request<'_>,
    imap: State<'_, Imap>,
) -> Result<Appended, MailServerError> {
    let meta: model::AppendMeta = header_json(&request)?;
    let id = calls::append(
        &imap,
        &meta.key,
        &meta.mailbox_id,
        &meta.flags,
        raw_body(&request),
    )
    .await?;
    Ok(Appended { id })
}

/// Starts IDLE for every kept account (desktop, at start).
#[cfg(desktop)]
pub fn watch_inboxes(app: &AppHandle) {
    idle::start_all(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::FixedKey;

    fn imap(name: &str) -> Imap {
        let dir = std::env::temp_dir().join(format!("action0-imap-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = rustls::crypto::ring::default_provider().install_default();
        Imap::new(
            crate::net::http_client(),
            LazyVault::new(dir.join("imap.vault"), Arc::new(FixedKey(vec![9; 32]))),
        )
    }

    fn account(address: &str, auth: ImapAuth) -> ImapAccount {
        ImapAccount {
            address: address.into(),
            name: "Max".into(),
            settings: MailServerSettings {
                imap: MailServer {
                    host: "127.0.0.1".into(),
                    port: 1,
                    security: Security::Tls,
                },
                smtp: MailServer {
                    host: "127.0.0.1".into(),
                    port: 1,
                    security: Security::Tls,
                },
                username: address.into(),
            },
            auth,
            pinned: Some(tls::format_fingerprint(&[0xAB; 32])),
            max_bytes: Some(1000),
        }
    }

    #[tokio::test]
    async fn keeps_forgets_and_changes_accounts() {
        let imap = imap("keep");
        let kept = account(
            "Max@Example.org",
            ImapAuth::Password {
                password: "secret".into(),
            },
        );
        imap.vault().put(&kept.key(), kept.clone());
        assert_eq!(kept.key(), "imap:max@example.org");
        assert_eq!(imap.account("imap:max@example.org").unwrap(), kept);
        assert_eq!(
            imap.account("imap:nobody@example.org").unwrap_err().kind,
            ErrorKind::NotFound
        );

        imap.forget_certificate("imap:max@example.org").unwrap();
        assert_eq!(imap.account("imap:max@example.org").unwrap().pinned, None);
        assert_eq!(
            imap.forget_certificate("imap:nobody@example.org")
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        imap.remove("imap:max@example.org");
        assert!(imap.vault().all().is_empty());
    }

    /// The local server the token tests renew at.
    static TOKEN_SERVER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

    #[tokio::test]
    async fn uses_a_kept_token_and_keeps_rotated_refresh_tokens() {
        use wiremock::matchers::{body_string_contains, method};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("refresh_token=r1"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "a2", "expires_in": 3600, "refresh_token": "r2"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("refresh_token=r2"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant"
            })))
            .mount(&server)
            .await;
        TOKEN_SERVER.get_or_init(|| server.uri());
        let mut imap = imap("tokens");
        imap.token_endpoint = |_| TOKEN_SERVER.get().unwrap().clone();
        let key = "imap:max@yahoo.com";
        imap.vault().put(
            key,
            account(
                "max@yahoo.com",
                ImapAuth::OAuth {
                    provider: OAuthProvider::Yahoo,
                    client: Client {
                        id: "id".into(),
                        secret: None,
                    },
                    refresh_token: "r1".into(),
                },
            ),
        );
        imap.keep_token(
            key,
            &TokenResponse {
                access_token: "a1".into(),
                expires_in: Some(3600),
                refresh_token: None,
                scope: None,
                id_token: None,
            },
        );
        let (credential, renewed) = imap.credential(key, false).await.unwrap();
        assert!(matches!(credential, Credential::Token(ref t) if t == "a1"));
        assert!(!renewed);

        // Renewed: the new token is used and the rotated refresh token kept.
        let (credential, renewed) = imap.credential(key, true).await.unwrap();
        assert!(matches!(credential, Credential::Token(ref t) if t == "a2"));
        assert!(renewed);
        let ImapAuth::OAuth { refresh_token, .. } = imap.account(key).unwrap().auth else {
            unreachable!()
        };
        assert_eq!(refresh_token, "r2");
        assert_eq!(imap.fresh_token(key).as_deref(), Some("a2"));

        // A refused refresh token means signing in again.
        let error = imap.credential(key, true).await.err().unwrap();
        assert_eq!(error.kind, ErrorKind::Auth);
    }

    #[tokio::test]
    async fn a_password_account_has_no_token_to_renew() {
        let imap = imap("password");
        let error = renew_access(
            &imap.http,
            &account(
                "a@b.c",
                ImapAuth::Password {
                    password: "x".into(),
                },
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Auth);
    }

    #[tokio::test]
    async fn a_refused_login_is_remembered_until_the_account_reconnects() {
        let imap = imap("refused");
        let key = "imap:max@example.org";
        imap.vault().put(
            key,
            account(
                "max@example.org",
                ImapAuth::Password {
                    password: "x".into(),
                },
            ),
        );
        imap.pool(key)
            .refuse(MailServerError::auth("Authentication failed."));
        assert_eq!(imap.session(key).await.err().unwrap().kind, ErrorKind::Auth);
        assert_eq!(
            imap.dedicated_session(key).await.err().unwrap().kind,
            ErrorKind::Auth
        );
        // A new pool tries again (port 1 isn't listening: unreachable).
        imap.close(key);
        let error = imap.session(key).await.err().unwrap();
        assert_eq!(error.kind, ErrorKind::Unreachable, "{error:?}");
    }

    #[test]
    fn lists_accounts_without_secrets() {
        let kept = account(
            "max@example.org",
            ImapAuth::Password {
                password: "secret".into(),
            },
        );
        let json = serde_json::to_string(&KeptAccounts {
            persistent: true,
            accounts: vec![kept.info()],
        })
        .unwrap();
        assert!(json.contains("\"signIn\":\"password\""));
        assert!(json.contains("\"maxBytes\":1000"));
        assert!(!json.contains("secret"));
    }
}
