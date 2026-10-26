//! Sign-in for the native apps: the system browser with PKCE (Google blocks
//! sign-in inside embedded web views), coming back through a loopback
//! redirect (desktop) or an `msauth://` link (Android). Codes are redeemed
//! here: Microsoft refuses that from a web view, and refresh tokens never
//! reach the UI, which only gets short-lived access tokens. On Android,
//! Google accounts go through Play services instead, with no refresh token.

pub mod loopback;
pub mod pkce;
pub mod providers;

use std::collections::HashMap;
use std::sync::Mutex;
#[cfg(desktop)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::vault::{LazyVault, StoredAccount, Vault};
#[cfg(desktop)]
use loopback::Loopback;
use loopback::PageTexts;
use pkce::{Pkce, random_token};
use providers::{Client, Provider, TokenError, TokenResponse, claims, has_scopes};

/// How long the browser has to come back (desktop; on Android the tab
/// reports its closing).
#[cfg(desktop)]
pub(crate) const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Access tokens are renewed when they have less than this left.
pub(crate) const RENEW_BEFORE_MS: u64 = 2 * 60 * 1000;
/// How long a token from Play services is taken to last (it doesn't say;
/// Google's last an hour).
#[cfg(target_os = "android")]
const PLAY_TOKEN_SECONDS: u64 = 50 * 60;

/// Why something didn't work, as the UI tells it apart.
#[derive(Debug, Serialize, thiserror::Error, PartialEq)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AuthError {
    /// Signing in again is needed (the refresh token is gone or refused).
    #[error("sign in again: {0}")]
    Reauth(String),
    /// The scopes asked for weren't granted.
    #[error("not granted: {0}")]
    Scopes(String),
    /// The sign-in was abandoned (another one started, or it timed out).
    #[error("cancelled: {0}")]
    Cancelled(String),
    /// The user declined, or didn't grant what's required.
    #[error("denied: {0}")]
    Denied(String),
    /// Signed in with another account than the one asked for.
    #[error("another account: {0}")]
    WrongAccount(String),
    /// No answer from the provider.
    #[error("network: {0}")]
    Network(String),
    /// The provider refused for another reason.
    #[error("provider: {0}")]
    Provider(String),
    /// Google accounts need Google Play services, which this phone lacks.
    #[error("no Play services: {0}")]
    NoPlayServices(String),
}

/// What the UI asks a sign-in for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    pub provider: Provider,
    pub client: Client,
    /// Everything to ask for (desktop apps can't add scopes later at Google).
    pub scopes: Vec<String>,
    /// Scopes without which the account is useless.
    pub required: Vec<String>,
    pub login_hint: Option<String>,
    /// `select_account` or `consent`.
    pub prompt: String,
    pub page: PageTexts,
}

/// A signed-in account, for the UI.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    /// The account id (`gmail:<email>`, `microsoft:<email>`).
    pub key: String,
    pub email: String,
    pub tenant: Option<String>,
    pub scopes: Vec<String>,
}

/// An access token for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessToken {
    pub access_token: String,
    /// Epoch ms.
    pub expires_at: u64,
}

/// The accounts kept between starts, and whether they can be.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsInfo {
    pub persistent: bool,
    pub accounts: Vec<Connected>,
}

struct Access {
    token: String,
    expires_at: u64,
}

/// Sign-in state: the vault, access tokens in memory, the running sign-in.
pub struct Auth {
    http: reqwest::Client,
    vault: LazyVault,
    access: Mutex<HashMap<String, Access>>,
    /// One renewal at a time (Microsoft replaces the refresh token).
    renewing: tokio::sync::Mutex<()>,
    /// Cancels the browser sign-in under way, if any.
    signing_in: Mutex<Option<oneshot::Sender<()>>>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

impl Auth {
    pub fn new(http: reqwest::Client, vault: LazyVault) -> Self {
        Self {
            http,
            vault,
            access: Mutex::new(HashMap::new()),
            renewing: tokio::sync::Mutex::new(()),
            signing_in: Mutex::new(None),
        }
    }

    fn vault(&self) -> &Vault {
        self.vault.get()
    }

    /// Signs in and returns the stored account: through Play services for
    /// Google on Android, else with the browser.
    async fn sign_in(
        &self,
        app: &AppHandle,
        request: &SignInRequest,
    ) -> Result<(String, StoredAccount, TokenResponse), AuthError> {
        #[cfg(target_os = "android")]
        if request.provider == Provider::Google {
            return self.play_sign_in(app, request).await;
        }
        self.browser_sign_in(app, request).await
    }

    /// Opens the provider's sign-in page in the browser and waits for its
    /// answer, on a loopback address: the redirect URI and the answer.
    #[cfg(desktop)]
    async fn round_trip(
        &self,
        app: &AppHandle,
        request: &SignInRequest,
        pkce: &Pkce,
        state: &str,
        cancelled: oneshot::Receiver<()>,
    ) -> Result<(String, HashMap<String, String>), AuthError> {
        let loopback = Loopback::bind()
            .await
            .map_err(|e| AuthError::Network(e.to_string()))?;
        let provider = request.provider;
        let redirect_uri = provider.redirect_uri(loopback.port);
        let url = authorize_url(request, &redirect_uri, pkce, state);
        open_browser(app, &url)?;
        let params = tokio::select! {
            result = tokio::time::timeout(
                SIGN_IN_TIMEOUT,
                loopback.wait(provider.redirect_path(), &request.page),
            ) => match result {
                Ok(Ok(params)) => params,
                Ok(Err(error)) => return Err(AuthError::Network(error.to_string())),
                Err(_) => return Err(AuthError::Cancelled("The sign-in timed out.".into())),
            },
            _ = cancelled => return Err(AuthError::Cancelled("Another sign-in started.".into())),
        };
        Ok((redirect_uri, params))
    }

    /// Opens the provider's sign-in page in a browser tab and waits for the
    /// `msauth://` link it comes back to (Android): the redirect URI and the answer.
    #[cfg(target_os = "android")]
    async fn round_trip(
        &self,
        app: &AppHandle,
        request: &SignInRequest,
        pkce: &Pkce,
        state: &str,
        cancelled: oneshot::Receiver<()>,
    ) -> Result<(String, HashMap<String, String>), AuthError> {
        let hash = kotlin(app, |side| side.signature_hash()).await?;
        let redirect_uri = providers::msauth_redirect(&app.config().identifier, &hash);
        let url = authorize_url(request, &redirect_uri, pkce, state);
        let redirect = redirect_uri.clone();
        let answer = tokio::select! {
            answer = kotlin(app, move |side| side.auth_tab(&url, &redirect)) => answer?,
            _ = cancelled => return Err(AuthError::Cancelled("Another sign-in started.".into())),
        };
        let answer = url::Url::parse(&answer)
            .map_err(|_| AuthError::Provider("A bad answer came back.".into()))?;
        let params = answer.query_pairs().into_owned().collect();
        Ok((redirect_uri, params))
    }

    /// Signs a Google account in through Play services (Android): an access
    /// token now and silently later, no refresh token.
    #[cfg(target_os = "android")]
    async fn play_sign_in(
        &self,
        app: &AppHandle,
        request: &SignInRequest,
    ) -> Result<(String, StoredAccount, TokenResponse), AuthError> {
        let scopes = request.scopes.clone();
        let hint = request.login_hint.clone();
        let token = kotlin(app, move |side| {
            side.google_authorize(&scopes, hint.as_deref(), true)
        })
        .await?;
        if !has_scopes(&token.granted_scopes, &request.required) {
            return Err(AuthError::Denied(
                "The access action0 needs wasn't granted.".into(),
            ));
        }
        let email = self.google_email(&token.access_token).await?;
        let key = format!("{}:{}", Provider::Google.key_prefix(), email.to_lowercase());
        let account = StoredAccount {
            provider: Provider::Google,
            client: Client {
                id: providers::PLAY_SERVICES.into(),
                secret: None,
            },
            refresh_token: String::new(),
            scopes: token.granted_scopes,
            email,
            tenant: None,
        };
        let tokens = TokenResponse {
            access_token: token.access_token,
            expires_in: Some(PLAY_TOKEN_SECONDS),
            refresh_token: None,
            scope: None,
            id_token: None,
        };
        Ok((key, account, tokens))
    }

    /// Whose token it is (Play services doesn't say): Gmail's profile.
    #[cfg(target_os = "android")]
    async fn google_email(&self, token: &str) -> Result<String, AuthError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Profile {
            email_address: String,
        }
        let response = self
            .http
            .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| AuthError::Network(e.to_string()))?;
        if !response.status().is_success() {
            return Err(AuthError::Provider(format!(
                "Gmail didn't say who signed in (HTTP {}).",
                response.status().as_u16()
            )));
        }
        response
            .json::<Profile>()
            .await
            .map(|profile| profile.email_address)
            .map_err(|e| AuthError::Provider(e.to_string()))
    }

    /// A fresh access token from Play services, without asking the user.
    #[cfg(target_os = "android")]
    async fn play_token(
        &self,
        app: &AppHandle,
        key: &str,
        account: &StoredAccount,
    ) -> Result<AccessToken, AuthError> {
        let scopes = account.scopes.clone();
        let email = account.email.clone();
        let token = kotlin(app, move |side| {
            side.google_authorize(&scopes, Some(&email), false)
        })
        .await?;
        let expires_at = now_ms() + PLAY_TOKEN_SECONDS * 1000;
        self.access.lock().expect("auth lock").insert(
            key.to_string(),
            Access {
                token: token.access_token.clone(),
                expires_at,
            },
        );
        Ok(AccessToken {
            access_token: token.access_token,
            expires_at,
        })
    }

    /// Signs in with the browser and returns the stored account.
    async fn browser_sign_in(
        &self,
        app: &AppHandle,
        request: &SignInRequest,
    ) -> Result<(String, StoredAccount, TokenResponse), AuthError> {
        // A new sign-in replaces one that's still waiting.
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = self.signing_in.lock().expect("auth lock").replace(cancel) {
            let _ = previous.send(());
        }

        let provider = request.provider;
        let pkce = Pkce::new();
        let state = random_token(16);
        let (redirect_uri, params) = self
            .round_trip(app, request, &pkce, &state, cancelled)
            .await?;
        if params.get("state") != Some(&state) {
            return Err(AuthError::Provider("The sign-in didn't match.".into()));
        }
        if let Some(error) = params.get("error") {
            let description = params.get("error_description").cloned().unwrap_or_default();
            return Err(match error.as_str() {
                "access_denied" => AuthError::Denied(description),
                _ => AuthError::Provider(format!("{error}: {description}")),
            });
        }
        let code = params
            .get("code")
            .ok_or_else(|| AuthError::Provider("No code came back.".into()))?;

        let form = provider.code_form(
            &request.client,
            code,
            &pkce.verifier,
            &redirect_uri,
            &request.scopes,
        );
        let tokens = self.token_request(provider, &form).await?;
        let granted: Vec<String> = match &tokens.scope {
            Some(scope) => scope.split(' ').map(str::to_string).collect(),
            None => request.scopes.clone(),
        };
        if !has_scopes(&granted, &request.required) {
            return Err(AuthError::Denied(
                "The access action0 needs wasn't granted.".into(),
            ));
        }
        let who = claims(tokens.id_token.as_deref().unwrap_or_default());
        let email = who
            .email
            .ok_or_else(|| AuthError::Provider("The provider didn't say who signed in.".into()))?;
        let key = format!("{}:{}", provider.key_prefix(), email.to_lowercase());
        // Signing in again may not bring a new refresh token: keep the old one.
        let refresh_token = tokens
            .refresh_token
            .clone()
            .or_else(|| self.vault().get(&key).map(|known| known.refresh_token))
            .ok_or_else(|| AuthError::Provider("No refresh token came back.".into()))?;
        let account = StoredAccount {
            provider,
            client: request.client.clone(),
            refresh_token,
            scopes: granted,
            email,
            tenant: who.tenant,
        };
        Ok((key, account, tokens))
    }

    /// Keeps a signed-in account and its first access token.
    fn keep(&self, key: &str, account: StoredAccount, tokens: &TokenResponse) -> Connected {
        self.access.lock().expect("auth lock").insert(
            key.to_string(),
            Access {
                token: tokens.access_token.clone(),
                expires_at: now_ms() + tokens.expires_in.unwrap_or(3600) * 1000,
            },
        );
        let connected = connected(key, &account);
        self.vault().put(key, account);
        connected
    }

    /// An access token for the account, renewed if it runs out soon.
    #[cfg_attr(desktop, allow(unused_variables))]
    async fn token(
        &self,
        app: &AppHandle,
        key: &str,
        scopes: &[String],
    ) -> Result<AccessToken, AuthError> {
        let account = self
            .vault()
            .get(key)
            .ok_or_else(|| AuthError::Reauth("The account isn't signed in.".into()))?;
        if !has_scopes(&account.scopes, scopes) {
            return Err(AuthError::Scopes(scopes.join(" ")));
        }
        if let Some(access) = self.fresh(key) {
            return Ok(access);
        }
        let _renewing = self.renewing.lock().await;
        // Someone else may have renewed it meanwhile.
        if let Some(access) = self.fresh(key) {
            return Ok(access);
        }
        let account = self
            .vault()
            .get(key)
            .ok_or_else(|| AuthError::Reauth("The account isn't signed in.".into()))?;
        #[cfg(target_os = "android")]
        if account.client.is_play_services() {
            return self.play_token(app, key, &account).await;
        }
        let form =
            account
                .provider
                .refresh_form(&account.client, &account.refresh_token, &account.scopes);
        let tokens = self.token_request(account.provider, &form).await?;
        let expires_at = now_ms() + tokens.expires_in.unwrap_or(3600) * 1000;
        self.access.lock().expect("auth lock").insert(
            key.to_string(),
            Access {
                token: tokens.access_token.clone(),
                expires_at,
            },
        );
        // Microsoft hands out a new refresh token every time.
        if let Some(refresh_token) = tokens.refresh_token {
            self.vault().put(
                key,
                StoredAccount {
                    refresh_token,
                    ..account
                },
            );
        }
        Ok(AccessToken {
            access_token: tokens.access_token,
            expires_at,
        })
    }

    fn fresh(&self, key: &str) -> Option<AccessToken> {
        let access = self.access.lock().expect("auth lock");
        let entry = access.get(key)?;
        (entry.expires_at > now_ms() + RENEW_BEFORE_MS).then(|| AccessToken {
            access_token: entry.token.clone(),
            expires_at: entry.expires_at,
        })
    }

    async fn token_request(
        &self,
        provider: Provider,
        form: &[(&'static str, String)],
    ) -> Result<TokenResponse, AuthError> {
        token_request(&self.http, provider.token_endpoint(), form).await
    }
}

/// Posts `form` to a token endpoint: its tokens, or what its refusal means.
pub(crate) async fn token_request(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&'static str, String)],
) -> Result<TokenResponse, AuthError> {
    let response = http
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if status.is_success() {
        return serde_json::from_str(&text).map_err(|e| AuthError::Provider(e.to_string()));
    }
    Err(token_error(&text, status.as_u16()))
}

/// What a token endpoint's refusal means for the UI.
fn token_error(body: &str, status: u16) -> AuthError {
    match serde_json::from_str::<TokenError>(body) {
        Ok(error) => {
            let message = error
                .error_description
                .unwrap_or_else(|| error.error.clone());
            match error.error.as_str() {
                "invalid_grant" | "interaction_required" | "consent_required" => {
                    AuthError::Reauth(message)
                }
                _ => AuthError::Provider(message),
            }
        }
        Err(_) => AuthError::Provider(format!("HTTP {status}")),
    }
}

fn connected(key: &str, account: &StoredAccount) -> Connected {
    Connected {
        key: key.to_string(),
        email: account.email.clone(),
        tenant: account.tenant.clone(),
        scopes: account.scopes.clone(),
    }
}

/// The provider's sign-in page for a request.
fn authorize_url(request: &SignInRequest, redirect_uri: &str, pkce: &Pkce, state: &str) -> String {
    request.provider.authorize_url(
        &request.client,
        &providers::Authorize {
            redirect_uri,
            scopes: &request.scopes,
            state,
            challenge: &pkce.challenge,
            prompt: &request.prompt,
            login_hint: request.login_hint.as_deref(),
        },
    )
}

/// Calls the Kotlin side, with its refusals as the UI tells them apart.
#[cfg(target_os = "android")]
pub(crate) async fn kotlin<T: Send + 'static>(
    app: &AppHandle,
    call: impl FnOnce(&tauri_plugin_action0::Action0<tauri::Wry>) -> tauri_plugin_action0::Result<T>
    + Send
    + 'static,
) -> Result<T, AuthError> {
    crate::mobile::kotlin(app, call).await.map_err(plugin_error)
}

/// What a refusal of the Kotlin side means for the UI.
#[cfg(target_os = "android")]
fn plugin_error(error: tauri_plugin_action0::Error) -> AuthError {
    let message = error.message;
    match error.code.as_deref() {
        Some("cancelled") => AuthError::Cancelled(message),
        Some("interaction") => AuthError::Reauth(message),
        Some("denied") => AuthError::Denied(message),
        Some("network") => AuthError::Network(message),
        Some("noPlayServices") => AuthError::NoPlayServices(message),
        _ => AuthError::Provider(message),
    }
}

#[cfg(desktop)]
pub(crate) fn open_browser(app: &AppHandle, url: &str) -> Result<(), AuthError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AuthError::Provider(format!("Couldn't open the browser: {e}")))
}

/// The accounts kept from earlier starts. (Async: on Android, opening the
/// vault asks the Kotlin side, which mustn't be waited for on the main thread.)
#[tauri::command]
pub async fn auth_accounts(auth: State<'_, Auth>) -> Result<AccountsInfo, AuthError> {
    Ok(AccountsInfo {
        persistent: auth.vault().persistent(),
        accounts: auth
            .vault()
            .all()
            .iter()
            .map(|(key, account)| connected(key, account))
            .collect(),
    })
}

/// Signs a new account in (with the browser).
#[tauri::command]
pub async fn auth_connect(
    app: AppHandle,
    auth: State<'_, Auth>,
    request: SignInRequest,
) -> Result<Connected, AuthError> {
    let (key, account, tokens) = auth.sign_in(&app, &request).await?;
    Ok(auth.keep(&key, account, &tokens))
}

/// Signs an account in again, e.g. after its access was revoked or to
/// grant more. Refuses another account than `key`.
#[tauri::command]
pub async fn auth_sign_in(
    app: AppHandle,
    auth: State<'_, Auth>,
    key: String,
    request: SignInRequest,
) -> Result<Connected, AuthError> {
    let (signed_in, account, tokens) = auth.sign_in(&app, &request).await?;
    if signed_in != key {
        return Err(AuthError::WrongAccount(account.email));
    }
    Ok(auth.keep(&key, account, &tokens))
}

/// An access token covering `scopes` (all granted ones if empty).
#[tauri::command]
pub async fn auth_token(
    app: AppHandle,
    auth: State<'_, Auth>,
    key: String,
    scopes: Vec<String>,
) -> Result<AccessToken, AuthError> {
    auth.token(&app, &key, &scopes).await
}

/// Signs an account out: revokes what can be revoked and forgets it.
#[tauri::command]
#[cfg_attr(desktop, allow(unused_variables))]
pub async fn auth_sign_out(
    app: AppHandle,
    auth: State<'_, Auth>,
    key: String,
) -> Result<(), AuthError> {
    let access = auth.access.lock().expect("auth lock").remove(&key);
    let Some(account) = auth.vault().remove(&key) else {
        return Ok(());
    };
    // Play services accounts have no refresh token: their access token
    // revokes the grant, and Play services forgets it.
    let token = if account.client.is_play_services() {
        let Some(access) = access else {
            return Ok(());
        };
        #[cfg(target_os = "android")]
        {
            let token = access.token.clone();
            let _ = kotlin(&app, move |side| side.google_clear(&token)).await;
        }
        access.token
    } else {
        account.refresh_token
    };
    if let Some(endpoint) = account.provider.revoke_endpoint() {
        // Best effort: it's forgotten here either way.
        let _ = auth
            .http
            .post(endpoint)
            .form(&[("token", token)])
            .send()
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_refusals_apart() {
        assert_eq!(
            token_error(
                r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
                400
            ),
            AuthError::Reauth("Token has been expired or revoked.".into())
        );
        assert_eq!(
            token_error(r#"{"error":"invalid_client"}"#, 401),
            AuthError::Provider("invalid_client".into())
        );
        assert_eq!(
            token_error("<html>", 502),
            AuthError::Provider("HTTP 502".into())
        );
    }

    #[test]
    fn errors_reach_the_ui_with_their_kind() {
        let json = serde_json::to_value(AuthError::Scopes("Calendars.ReadWrite".into())).unwrap();
        assert_eq!(json["kind"], "scopes");
        assert_eq!(json["message"], "Calendars.ReadWrite");
    }
}
