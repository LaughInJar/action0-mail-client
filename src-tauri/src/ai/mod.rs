//! The AI assistant's native side. API keys and ChatGPT sign-ins are kept
//! in their own vault file (`ai.vault`, encrypted with the accounts'
//! key) and added to the UI's requests here, only for the address each
//! one belongs to, so they never reach the web view. Answers stream back
//! through a channel as they're written: first the status and headers,
//! then the body's chunks as raw bytes, then the end.

pub mod chatgpt;
pub mod openrouter;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::oauth::loopback::{Answer, Loopback, PageTexts};
use crate::oauth::pkce::{Pkce, random_token};
use crate::oauth::providers::TokenResponse;
use crate::oauth::{AuthError, RENEW_BEFORE_MS, now_ms, token_request};
use crate::vault::{LazyVault, Vault};

/// Where a key goes in a request.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum KeyHeader {
    /// Anthropic's `x-api-key`.
    #[serde(rename = "x-api-key")]
    XApiKey,
    /// `Authorization: Bearer <key>` (OpenAI and the services like it).
    #[serde(rename = "bearer")]
    Bearer,
}

impl KeyHeader {
    fn with(self, key: &str) -> (&'static str, String) {
        match self {
            Self::XApiKey => ("x-api-key", key.to_string()),
            Self::Bearer => ("authorization", format!("Bearer {key}")),
        }
    }
}

/// What the AI vault keeps, by service id.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiSecret {
    /// An API key, sent only to `base` and the addresses below it.
    Key {
        key: String,
        base: String,
        header: KeyHeader,
    },
    /// A ChatGPT sign-in: the client issued to this install, the refresh
    /// token, and who signed in.
    #[serde(rename = "chatgpt")]
    ChatGpt {
        client_id: String,
        refresh_token: String,
        account: String,
    },
    /// This install's id at ChatGPT (`ext_agent_host_id`).
    Host { id: String },
}

/// The vault entry with this install's ChatGPT id (service ids are random).
const HOST_ENTRY: &str = "@chatgpt-host";

struct Access {
    token: String,
    expires_at: u64,
}

/// The AI assistant's state: the vault, ChatGPT's access tokens in
/// memory, the requests under way, and the sign-in waiting for the browser.
pub struct Ai {
    http: reqwest::Client,
    vault: LazyVault<AiSecret>,
    access: Mutex<HashMap<String, Access>>,
    /// One renewal at a time (refresh tokens rotate).
    renewing: tokio::sync::Mutex<()>,
    running: Mutex<HashMap<u32, tokio::task::AbortHandle>>,
    signing_in: Mutex<Option<oneshot::Sender<()>>>,
}

/// What a request gets added.
enum Credentials {
    /// Nothing: the service has no key (a local server).
    None,
    Header(&'static str, String),
    /// The ChatGPT sign-in has run out; it's answered as a 401.
    SignInAgain(String),
}

impl Ai {
    pub fn new(http: reqwest::Client, vault: LazyVault<AiSecret>) -> Self {
        Self {
            http,
            vault,
            access: Mutex::new(HashMap::new()),
            renewing: tokio::sync::Mutex::new(()),
            running: Mutex::new(HashMap::new()),
            signing_in: Mutex::new(None),
        }
    }

    fn vault(&self) -> &Vault<AiSecret> {
        self.vault.get()
    }

    /// This install's id at ChatGPT, made on first use.
    fn host_id(&self) -> String {
        if let Some(AiSecret::Host { id }) = self.vault().get(HOST_ENTRY) {
            return id;
        }
        let id = chatgpt::new_host_id();
        self.vault()
            .put(HOST_ENTRY, AiSecret::Host { id: id.clone() });
        id
    }

    /// What a request of service `id` to `url` gets added. Refuses
    /// addresses its key or sign-in isn't for.
    async fn credentials(&self, id: &str, url: &url::Url) -> Result<Credentials, String> {
        match self.vault().get(id) {
            Some(AiSecret::Key { key, base, header }) => {
                if !allowed(url, &base) {
                    return Err(format!("This service's key is only sent to {base}."));
                }
                let (name, value) = header.with(&key);
                Ok(Credentials::Header(name, value))
            }
            Some(AiSecret::ChatGpt { .. }) => {
                if !allowed(url, chatgpt::API) {
                    return Err(format!(
                        "ChatGPT's sign-in is only sent to {}.",
                        chatgpt::API
                    ));
                }
                match self.chatgpt_token(id).await {
                    Ok(token) => Ok(Credentials::Header(
                        "authorization",
                        format!("Bearer {token}"),
                    )),
                    Err(AuthError::Network(message)) => Err(message),
                    Err(error) => Ok(Credentials::SignInAgain(error.to_string())),
                }
            }
            _ => Ok(Credentials::None),
        }
    }

    fn fresh(&self, id: &str) -> Option<String> {
        let access = self.access.lock().expect("ai lock");
        let entry = access.get(id)?;
        (entry.expires_at > now_ms() + RENEW_BEFORE_MS).then(|| entry.token.clone())
    }

    fn keep_access(&self, id: &str, tokens: &TokenResponse) {
        self.access.lock().expect("ai lock").insert(
            id.to_string(),
            Access {
                token: tokens.access_token.clone(),
                expires_at: now_ms() + tokens.expires_in.unwrap_or(3600) * 1000,
            },
        );
    }

    /// An access token for the ChatGPT sign-in, renewed if it runs out soon.
    async fn chatgpt_token(&self, id: &str) -> Result<String, AuthError> {
        if let Some(token) = self.fresh(id) {
            return Ok(token);
        }
        let _renewing = self.renewing.lock().await;
        // Someone else may have renewed it meanwhile.
        if let Some(token) = self.fresh(id) {
            return Ok(token);
        }
        let Some(AiSecret::ChatGpt {
            client_id,
            refresh_token,
            account,
        }) = self.vault().get(id)
        else {
            return Err(AuthError::Reauth("ChatGPT isn't signed in.".into()));
        };
        let form = chatgpt::refresh_form(&client_id, &refresh_token);
        let tokens = token_request(&self.http, chatgpt::TOKEN, &form).await?;
        self.keep_access(id, &tokens);
        if let Some(refresh_token) = tokens.refresh_token {
            self.vault().put(
                id,
                AiSecret::ChatGpt {
                    client_id,
                    refresh_token,
                    account,
                },
            );
        }
        Ok(tokens.access_token)
    }

    /// Starts a sign-in: one still waiting for the browser is cancelled.
    fn begin_sign_in(&self) -> oneshot::Receiver<()> {
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = self.signing_in.lock().expect("ai lock").replace(cancel) {
            let _ = previous.send(());
        }
        cancelled
    }
}

/// The address a key is for, as requests are compared with it: a web
/// address without a trailing slash.
fn normal_base(base: &str) -> Result<String, String> {
    let url = url::Url::parse(base).map_err(|_| "Not a web address.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Not a web address.".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// True if `url` is `base` or below it (compared after parsing, so `..`
/// or a user name can't lead elsewhere).
fn allowed(url: &url::Url, base: &str) -> bool {
    let url = url.as_str();
    url == base
        || url
            .strip_prefix(base)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?'))
}

/// A message of the request's channel.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Event {
    Head {
        status: u16,
        status_text: String,
        headers: Vec<(String, String)>,
    },
    End,
    Error {
        message: String,
    },
}

fn json(event: &Event) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(event).expect("events serialize"))
}

/// Passes the answer on as it comes: its head, the body's chunks, and the
/// end or what broke it off. Stops when `send` says nobody listens.
async fn relay(mut response: reqwest::Response, send: impl Fn(InvokeResponseBody) -> bool) {
    let status = response.status();
    let head = Event::Head {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        headers: response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect(),
    };
    if !send(json(&head)) {
        return;
    }
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                if !send(InvokeResponseBody::Raw(bytes.to_vec())) {
                    return;
                }
            }
            Ok(None) => {
                send(json(&Event::End));
                return;
            }
            Err(error) => {
                send(json(&Event::Error {
                    message: error.to_string(),
                }));
                return;
            }
        }
    }
}

/// A ChatGPT sign-in that ran out, answered as the API would refuse it.
fn sign_in_again(message: &str, send: impl Fn(InvokeResponseBody) -> bool) {
    let body = serde_json::json!({
        "error": { "code": "sign_in_again", "message": message }
    });
    let _ = send(json(&Event::Head {
        status: 401,
        status_text: "Unauthorized".into(),
        headers: vec![("content-type".into(), "application/json".into())],
    })) && send(InvokeResponseBody::Raw(body.to_string().into_bytes()))
        && send(json(&Event::End));
}

/// The code a sign-in came back with, or why there's none.
fn callback_code(
    params: &HashMap<String, String>,
    state: Option<&str>,
) -> Result<String, AuthError> {
    if let Some(state) = state
        && params.get("state").map(String::as_str) != Some(state)
    {
        return Err(AuthError::Provider("The sign-in didn't match.".into()));
    }
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone());
        return Err(match error.as_str() {
            "access_denied" => AuthError::Denied(description),
            _ => AuthError::Provider(description),
        });
    }
    params
        .get("code")
        .cloned()
        .ok_or_else(|| AuthError::Provider("No code came back.".into()))
}

/// Opens `url` in the browser and waits for it to come back to the
/// loopback address at `path` with `required`: the query.
#[cfg(desktop)]
async fn round_trip(
    app: &AppHandle,
    loopback: &Loopback,
    url: &str,
    path: &str,
    required: &str,
    page: &PageTexts,
    cancelled: oneshot::Receiver<()>,
) -> Result<HashMap<String, String>, AuthError> {
    crate::oauth::open_browser(app, url)?;
    tokio::select! {
        result = tokio::time::timeout(
            crate::oauth::SIGN_IN_TIMEOUT,
            loopback.wait_for(path, required, Answer::Page(page)),
        ) => match result {
            Ok(Ok(params)) => Ok(params),
            Ok(Err(error)) => Err(AuthError::Network(error.to_string())),
            Err(_) => Err(AuthError::Cancelled("The sign-in timed out.".into())),
        },
        _ = cancelled => Err(AuthError::Cancelled("Another sign-in started.".into())),
    }
}

/// Opens `url` in a browser tab and waits for it to come back to the
/// loopback address at `path` with `required`: the query. The loopback
/// address sends the browser on to the app's own link, which closes the
/// tab and brings the app back.
#[cfg(target_os = "android")]
async fn round_trip(
    app: &AppHandle,
    loopback: &Loopback,
    url: &str,
    path: &str,
    required: &str,
    _page: &PageTexts,
    cancelled: oneshot::Receiver<()>,
) -> Result<HashMap<String, String>, AuthError> {
    let back = format!("msauth://{}/action0-ai", app.config().identifier);
    let done = format!("{back}?done");
    let (tab_url, tab_back) = (url.to_string(), back);
    let tab = crate::oauth::kotlin(app, move |side| side.auth_tab(&tab_url, &tab_back));
    tokio::pin!(tab);
    tokio::select! {
        biased;
        result = loopback.wait_for(path, required, Answer::Redirect(&done)) => {
            result.map_err(|error| AuthError::Network(error.to_string()))
        }
        result = &mut tab => match result {
            Err(error) => Err(error),
            Ok(_) => Err(AuthError::Cancelled("The sign-in didn't come back.".into())),
        },
        _ = cancelled => Err(AuthError::Cancelled("Another sign-in started.".into())),
    }
}

/// The services with a key or sign-in kept.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSecrets {
    /// False without an OS keychain: they're kept only until quitting.
    pub persistent: bool,
    pub ids: Vec<String>,
}

/// Which services have a key or sign-in. (Async: on Android, opening the
/// vault asks the Kotlin side, which mustn't be waited for on the main thread.)
#[tauri::command]
pub async fn ai_secrets(ai: State<'_, Ai>) -> Result<AiSecrets, String> {
    let vault = ai.vault();
    Ok(AiSecrets {
        persistent: vault.persistent(),
        ids: vault
            .all()
            .into_iter()
            .filter(|(_, secret)| !matches!(secret, AiSecret::Host { .. }))
            .map(|(id, _)| id)
            .collect(),
    })
}

/// Keeps a service's API key, to be sent only to `base` and below it.
#[tauri::command]
pub async fn ai_save_key(
    ai: State<'_, Ai>,
    id: String,
    key: String,
    base: String,
    header: KeyHeader,
) -> Result<(), String> {
    let base = normal_base(&base)?;
    ai.access.lock().expect("ai lock").remove(&id);
    ai.vault().put(&id, AiSecret::Key { key, base, header });
    Ok(())
}

/// Forgets a service's key or sign-in (a ChatGPT sign-in is revoked too,
/// as far as that works).
#[tauri::command]
pub async fn ai_forget(ai: State<'_, Ai>, id: String) -> Result<(), String> {
    ai.access.lock().expect("ai lock").remove(&id);
    if let Some(AiSecret::ChatGpt {
        client_id,
        refresh_token,
        ..
    }) = ai.vault().remove(&id)
    {
        let _ = ai
            .http
            .post(chatgpt::REVOKE)
            .form(&chatgpt::revoke_form(&client_id, &refresh_token))
            .send()
            .await;
    }
    Ok(())
}

/// A request of the UI, apart from its body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequestMeta {
    /// For aborting it.
    pub request_id: u32,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// Sends a request of service `id` with its key or sign-in added and
/// streams the answer into `on_event` (see the module docs). Rejects when
/// there was no answer at all, or `"aborted"`.
#[tauri::command]
pub async fn ai_request(
    ai: State<'_, Ai>,
    id: String,
    request: AiRequestMeta,
    body: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let url = url::Url::parse(&request.url).map_err(|_| "Not a URL.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(format!(
            "Only web addresses can be fetched, not {}:",
            url.scheme()
        ));
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Bad method.".to_string())?;
    let send = move |body| on_event.send(body).is_ok();
    let header = match ai.credentials(&id, &url).await? {
        Credentials::SignInAgain(message) => {
            sign_in_again(&message, send);
            return Ok(());
        }
        Credentials::Header(name, value) => Some((name, value)),
        Credentials::None => None,
    };
    let mut builder = ai.http.request(method, url);
    for (name, value) in &request.headers {
        // The UI never sets the key itself.
        let credential =
            name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("x-api-key");
        if !(credential && header.is_some()) {
            builder = builder.header(name, value);
        }
    }
    if let Some((name, value)) = header {
        builder = builder.header(name, value);
    }
    if let Some(body) = body {
        builder = builder.body(body);
    }

    let task = tokio::spawn(async move {
        let response = builder.send().await.map_err(|error| error.to_string())?;
        relay(response, send).await;
        Ok::<_, String>(())
    });
    ai.running
        .lock()
        .expect("ai lock")
        .insert(request.request_id, task.abort_handle());
    let result = task.await;
    ai.running
        .lock()
        .expect("ai lock")
        .remove(&request.request_id);
    match result {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("aborted".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// Aborts a request the UI no longer wants.
#[tauri::command]
pub fn ai_abort(ai: State<'_, Ai>, request_id: u32) {
    if let Some(handle) = ai.running.lock().expect("ai lock").remove(&request_id) {
        handle.abort();
    }
}

/// Signs in at OpenRouter and keeps the key it hands out.
#[tauri::command]
pub async fn ai_openrouter_sign_in(
    app: AppHandle,
    ai: State<'_, Ai>,
    id: String,
    page: PageTexts,
) -> Result<(), AuthError> {
    let cancelled = ai.begin_sign_in();
    let loopback = Loopback::bind()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    let pkce = Pkce::new();
    let url = openrouter::auth_url(&openrouter::callback_url(loopback.port), &pkce.challenge);
    let params = round_trip(
        &app,
        &loopback,
        &url,
        openrouter::CALLBACK_PATH,
        "code",
        &page,
        cancelled,
    )
    .await?;
    let code = callback_code(&params, None)?;
    let response = ai
        .http
        .post(openrouter::KEYS)
        .json(&openrouter::exchange_body(&code, &pkce.verifier))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AuthError::Provider(format!(
            "OpenRouter didn't hand out a key (HTTP {}).",
            response.status().as_u16()
        )));
    }
    let answer: openrouter::KeyAnswer = response
        .json()
        .await
        .map_err(|e| AuthError::Provider(e.to_string()))?;
    ai.vault().put(
        &id,
        AiSecret::Key {
            key: answer.key,
            base: openrouter::API.into(),
            header: KeyHeader::Bearer,
        },
    );
    Ok(())
}

/// Who signed in with ChatGPT.
#[derive(Debug, Serialize)]
pub struct ChatGptAccount {
    pub account: String,
}

/// Signs in with ChatGPT, to use the plan for service `id`.
#[tauri::command]
pub async fn ai_chatgpt_sign_in(
    app: AppHandle,
    ai: State<'_, Ai>,
    id: String,
    page: PageTexts,
) -> Result<ChatGptAccount, AuthError> {
    let cancelled = ai.begin_sign_in();
    let host_id = ai.host_id();
    // Signing in again: the client this install was given before.
    let known = match ai.vault().get(&id) {
        Some(AiSecret::ChatGpt { client_id, .. }) => Some(client_id),
        _ => None,
    };
    let loopback = Loopback::bind()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    let redirect_uri = chatgpt::redirect_uri(loopback.port);
    let pkce = Pkce::new();
    let state = random_token(16);
    let nonce = random_token(16);
    let url = chatgpt::authorize_url(&chatgpt::Authorize {
        client_id: known.as_deref().unwrap_or(chatgpt::NEW_CLIENT),
        redirect_uri: &redirect_uri,
        challenge: &pkce.challenge,
        state: &state,
        nonce: &nonce,
        host_id: &host_id,
    });
    let params = round_trip(
        &app,
        &loopback,
        &url,
        chatgpt::CALLBACK_PATH,
        "state",
        &page,
        cancelled,
    )
    .await?;
    let code = callback_code(&params, Some(&state))?;
    // A new install is told its client id on the way back.
    let client_id = params
        .get("client_id")
        .cloned()
        .or(known)
        .ok_or_else(|| AuthError::Provider("ChatGPT didn't register action0.".into()))?;
    let form = chatgpt::code_form(&client_id, &code, &pkce.verifier, &redirect_uri);
    let tokens = token_request(&ai.http, chatgpt::TOKEN, &form).await?;
    let account = chatgpt::signed_in(&tokens, &client_id, &nonce)?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| AuthError::Provider("No refresh token came back.".into()))?;
    ai.keep_access(&id, &tokens);
    ai.vault().put(
        &id,
        AiSecret::ChatGpt {
            client_id,
            refresh_token,
            account: account.clone(),
        },
    );
    Ok(ChatGptAccount { account })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::vault::FixedKey;

    fn ai(name: &str) -> Ai {
        let dir = std::env::temp_dir().join(format!("action0-ai-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ai::new(
            crate::net::http_client(),
            LazyVault::new(dir.join("ai.vault"), Arc::new(FixedKey(vec![7; 32]))),
        )
    }

    fn url(text: &str) -> url::Url {
        url::Url::parse(text).unwrap()
    }

    #[test]
    fn sends_keys_only_to_their_service() {
        let base = normal_base("https://api.anthropic.com/v1/").unwrap();
        assert_eq!(base, "https://api.anthropic.com/v1");
        assert!(allowed(
            &url("https://api.anthropic.com/v1/messages"),
            &base
        ));
        assert!(allowed(&url("https://api.anthropic.com/v1"), &base));
        assert!(allowed(&url("https://api.anthropic.com/v1?x=1"), &base));
        assert!(!allowed(&url("https://api.anthropic.com/v1beta/x"), &base));
        assert!(!allowed(&url("https://api.anthropic.com/v1/../x"), &base));
        assert!(!allowed(
            &url("https://api.anthropic.com.evil.org/v1/x"),
            &base
        ));
        assert!(!allowed(
            &url("https://api.anthropic.com@evil.org/v1/x"),
            &base
        ));
        assert!(!allowed(
            &url("http://api.anthropic.com/v1/messages"),
            &base
        ));
        assert!(normal_base("file:///etc").is_err());
        // A server without a path.
        let root = normal_base("http://localhost:11434").unwrap();
        assert!(allowed(&url("http://localhost:11434/v1/models"), &root));
    }

    #[test]
    fn puts_the_key_where_the_service_wants_it() {
        assert_eq!(KeyHeader::XApiKey.with("k"), ("x-api-key", "k".to_string()));
        assert_eq!(
            KeyHeader::Bearer.with("k"),
            ("authorization", "Bearer k".to_string())
        );
        assert_eq!(
            serde_json::from_str::<KeyHeader>("\"x-api-key\"").unwrap(),
            KeyHeader::XApiKey
        );
    }

    #[tokio::test]
    async fn adds_credentials_by_service() {
        let ai = ai("credentials");
        ai.vault().put(
            "claude",
            AiSecret::Key {
                key: "sk".into(),
                base: "https://api.anthropic.com/v1".into(),
                header: KeyHeader::XApiKey,
            },
        );
        let Ok(Credentials::Header(name, value)) = ai
            .credentials("claude", &url("https://api.anthropic.com/v1/messages"))
            .await
        else {
            panic!("no key");
        };
        assert_eq!((name, value.as_str()), ("x-api-key", "sk"));
        assert!(
            ai.credentials("claude", &url("https://evil.org/v1/messages"))
                .await
                .is_err()
        );
        assert!(matches!(
            ai.credentials("ollama", &url("http://localhost:11434/v1/models"))
                .await,
            Ok(Credentials::None)
        ));
    }

    #[test]
    fn keeps_secrets_apart_from_the_install_id() {
        let ai = ai("secrets");
        let host = ai.host_id();
        assert_eq!(ai.host_id(), host);
        ai.vault().put(
            "gpt",
            AiSecret::ChatGpt {
                client_id: "oaiapp_1".into(),
                refresh_token: "r".into(),
                account: "a@b.c".into(),
            },
        );
        let ids: Vec<String> = ai
            .vault()
            .all()
            .into_iter()
            .filter(|(_, secret)| !matches!(secret, AiSecret::Host { .. }))
            .map(|(id, _)| id)
            .collect();
        assert_eq!(ids, vec!["gpt".to_string()]);
        // Written as tagged JSON, read back the same.
        let json = serde_json::to_value(ai.vault().get("gpt").unwrap()).unwrap();
        assert_eq!(json["type"], "chatgpt");
        assert_eq!(json["clientId"], "oaiapp_1");
        let reopened: Vault<AiSecret> = Vault::open(
            std::env::temp_dir()
                .join(format!("action0-ai-secrets-{}", std::process::id()))
                .join("ai.vault"),
            &FixedKey(vec![7; 32]),
        );
        assert_eq!(reopened.get(HOST_ENTRY), Some(AiSecret::Host { id: host }));
    }

    #[test]
    fn reads_what_the_sign_in_brought_back() {
        let params = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            callback_code(&params(&[("code", "c"), ("state", "s")]), Some("s")),
            Ok("c".into())
        );
        assert!(callback_code(&params(&[("code", "c"), ("state", "x")]), Some("s")).is_err());
        assert_eq!(
            callback_code(&params(&[("error", "access_denied")]), None),
            Err(AuthError::Denied("access_denied".into()))
        );
        assert_eq!(
            callback_code(&params(&[("code", "c")]), None),
            Ok("c".into())
        );
    }

    #[tokio::test]
    async fn relays_the_answer_as_it_comes() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: hello\n\n"),
            )
            .mount(&server)
            .await;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let response = crate::net::http_client()
            .get(server.uri())
            .send()
            .await
            .unwrap();
        let events = Mutex::new(Vec::new());
        relay(response, |body| {
            events.lock().unwrap().push(body);
            true
        })
        .await;
        let events = events.into_inner().unwrap();
        let InvokeResponseBody::Json(head) = &events[0] else {
            panic!("no head");
        };
        let head: serde_json::Value = serde_json::from_str(head).unwrap();
        assert_eq!(head["kind"], "head");
        assert_eq!(head["status"], 200);
        assert_eq!(head["statusText"], "OK");
        let body: Vec<u8> = events[1..events.len() - 1]
            .iter()
            .flat_map(|event| match event {
                InvokeResponseBody::Raw(bytes) => bytes.clone(),
                InvokeResponseBody::Json(_) => panic!("not a chunk"),
            })
            .collect();
        assert_eq!(body, b"data: hello\n\n");
        let InvokeResponseBody::Json(end) = events.last().unwrap() else {
            panic!("no end");
        };
        assert_eq!(end, r#"{"kind":"end"}"#);
    }

    #[test]
    fn answers_a_lapsed_sign_in_like_the_api() {
        let events = Mutex::new(Vec::new());
        sign_in_again("Sign in again.", |body| {
            events.lock().unwrap().push(body);
            true
        });
        let events = events.into_inner().unwrap();
        assert_eq!(events.len(), 3);
        let InvokeResponseBody::Json(head) = &events[0] else {
            panic!("no head");
        };
        assert!(head.contains("\"status\":401"));
        let InvokeResponseBody::Raw(body) = &events[1] else {
            panic!("no body");
        };
        assert!(String::from_utf8_lossy(body).contains("sign_in_again"));
    }
}
