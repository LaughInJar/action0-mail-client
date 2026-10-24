//! Sign-in for the desktop app: the system browser, a loopback redirect and
//! PKCE (Google blocks sign-in inside embedded web views). Codes are
//! redeemed here: Microsoft refuses that from a web view, and refresh
//! tokens never reach the UI. The UI only gets short-lived access tokens.

pub mod loopback;
pub mod pkce;
pub mod providers;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::vault::{StoredAccount, Vault};
use loopback::{Loopback, PageTexts};
use pkce::{Pkce, random_token};
use providers::{Client, Provider, TokenError, TokenResponse, claims, has_scopes};

/// How long the browser has to come back.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Access tokens are renewed when they have less than this left.
const RENEW_BEFORE_MS: u64 = 2 * 60 * 1000;

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
    vault: Vault,
    access: Mutex<HashMap<String, Access>>,
    /// One renewal at a time (Microsoft replaces the refresh token).
    renewing: tokio::sync::Mutex<()>,
    /// Cancels the browser sign-in under way, if any.
    signing_in: Mutex<Option<oneshot::Sender<()>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

impl Auth {
    pub fn new(http: reqwest::Client, vault: Vault) -> Self {
        Self {
            http,
            vault,
            access: Mutex::new(HashMap::new()),
            renewing: tokio::sync::Mutex::new(()),
            signing_in: Mutex::new(None),
        }
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

        let loopback = Loopback::bind()
            .await
            .map_err(|e| AuthError::Network(e.to_string()))?;
        let provider = request.provider;
        let redirect_uri = provider.redirect_uri(loopback.port);
        let pkce = Pkce::new();
        let state = random_token(16);
        let url = provider.authorize_url(
            &request.client,
            &providers::Authorize {
                redirect_uri: &redirect_uri,
                scopes: &request.scopes,
                state: &state,
                challenge: &pkce.challenge,
                prompt: &request.prompt,
                login_hint: request.login_hint.as_deref(),
            },
        );
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
            .or_else(|| self.vault.get(&key).map(|known| known.refresh_token))
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
        self.vault.put(key, account);
        connected
    }

    /// An access token for the account, renewed if it runs out soon.
    async fn token(&self, key: &str, scopes: &[String]) -> Result<AccessToken, AuthError> {
        let account = self
            .vault
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
            .vault
            .get(key)
            .ok_or_else(|| AuthError::Reauth("The account isn't signed in.".into()))?;
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
            self.vault.put(
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
        let response = self
            .http
            .post(provider.token_endpoint())
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

fn open_browser(app: &AppHandle, url: &str) -> Result<(), AuthError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AuthError::Provider(format!("Couldn't open the browser: {e}")))
}

/// The accounts kept from earlier starts.
#[tauri::command]
pub fn auth_accounts(auth: State<'_, Auth>) -> AccountsInfo {
    AccountsInfo {
        persistent: auth.vault.persistent(),
        accounts: auth
            .vault
            .all()
            .iter()
            .map(|(key, account)| connected(key, account))
            .collect(),
    }
}

/// Signs a new account in (with the browser).
#[tauri::command]
pub async fn auth_connect(
    app: AppHandle,
    auth: State<'_, Auth>,
    request: SignInRequest,
) -> Result<Connected, AuthError> {
    let (key, account, tokens) = auth.browser_sign_in(&app, &request).await?;
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
    let (signed_in, account, tokens) = auth.browser_sign_in(&app, &request).await?;
    if signed_in != key {
        return Err(AuthError::WrongAccount(account.email));
    }
    Ok(auth.keep(&key, account, &tokens))
}

/// An access token covering `scopes` (all granted ones if empty).
#[tauri::command]
pub async fn auth_token(
    auth: State<'_, Auth>,
    key: String,
    scopes: Vec<String>,
) -> Result<AccessToken, AuthError> {
    auth.token(&key, &scopes).await
}

/// Signs an account out: revokes what can be revoked and forgets it.
#[tauri::command]
pub async fn auth_sign_out(auth: State<'_, Auth>, key: String) -> Result<(), AuthError> {
    auth.access.lock().expect("auth lock").remove(&key);
    if let Some(account) = auth.vault.remove(&key)
        && let Some(endpoint) = account.provider.revoke_endpoint()
    {
        // Best effort: it's forgotten here either way.
        let _ = auth
            .http
            .post(endpoint)
            .form(&[("token", account.refresh_token)])
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
