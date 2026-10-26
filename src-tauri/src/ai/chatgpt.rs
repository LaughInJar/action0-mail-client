//! Sign in with ChatGPT: the user's ChatGPT plan instead of an API key.
//! Each install registers itself on the first sign-in (`dynamic_agent_client`
//! with this install's `ext_agent_host_id`) and gets its own client id back;
//! the browser returns to a loopback address (only `127.0.0.1` is allowed).
//! Access tokens last an hour, refresh tokens rotate.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::Deserialize;

use crate::oauth::AuthError;
use crate::oauth::providers::TokenResponse;

pub const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
pub const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const REVOKE: &str = "https://auth.openai.com/oauth/revoke";
/// Where ChatGPT's tokens may be sent (the Responses API and the model list).
pub const API: &str = "https://api.openai.com/v1";
/// The client id of an install that has none yet: it registers on signing in.
pub const NEW_CLIENT: &str = "dynamic_agent_client";
/// The scope that lets the app use the plan.
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The name the user sees for the app (and can change) when signing in.
const AGENT_NAME: &str = "action0";
/// Where the browser comes back to.
pub const CALLBACK_PATH: &str = "/auth/callback";

/// The loopback redirect for `port` (ChatGPT refuses `localhost`).
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// A new id for this install (`ext_agent_host_id`): a random UUID URN.
pub fn new_host_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    // Version 4, variant RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// What the sign-in page is asked for.
pub struct Authorize<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub challenge: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub host_id: &'a str,
}

/// The sign-in page's address.
pub fn authorize_url(sign_in: &Authorize<'_>) -> String {
    url::Url::parse_with_params(
        AUTHORIZE,
        &[
            ("response_type", "code"),
            ("client_id", sign_in.client_id),
            ("redirect_uri", sign_in.redirect_uri),
            ("scope", SCOPES),
            ("resource", API),
            ("code_challenge", sign_in.challenge),
            ("code_challenge_method", "S256"),
            ("state", sign_in.state),
            ("nonce", sign_in.nonce),
            ("agent_name_hint", AGENT_NAME),
            ("ext_agent_host_id", sign_in.host_id),
        ],
    )
    .expect("the authorize URL parses")
    .to_string()
}

/// Redeems the code the browser brought back.
pub fn code_form(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("grant_type", "authorization_code".into()),
        ("code", code.into()),
        ("redirect_uri", redirect_uri.into()),
        ("client_id", client_id.into()),
        ("code_verifier", verifier.into()),
        ("resource", API.into()),
    ]
}

/// Renews the access token (the answer brings a new refresh token).
pub fn refresh_form(client_id: &str, refresh_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("grant_type", "refresh_token".into()),
        ("refresh_token", refresh_token.into()),
        ("client_id", client_id.into()),
        ("resource", API.into()),
    ]
}

/// Revokes a refresh token (signing out).
pub fn revoke_form(client_id: &str, refresh_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("token", refresh_token.into()),
        ("token_type_hint", "refresh_token".into()),
        ("client_id", client_id.into()),
    ]
}

/// Who signed in, once the tokens are checked: the plan may be used (the
/// scope was granted), and the ID token is for this client and this
/// sign-in (it came straight from OpenAI over TLS, so its signature isn't
/// checked again).
pub fn signed_in(
    tokens: &TokenResponse,
    client_id: &str,
    nonce: &str,
) -> Result<String, AuthError> {
    let granted = tokens
        .scope
        .as_deref()
        .is_some_and(|scope| scope.split(' ').any(|s| s == PLAN_SCOPE));
    if !granted {
        return Err(AuthError::Denied(
            "Using the ChatGPT plan wasn't allowed.".into(),
        ));
    }
    let token = tokens
        .id_token
        .as_deref()
        .ok_or_else(|| AuthError::Provider("ChatGPT didn't say who signed in.".into()))?;
    id_token_email(token, client_id, nonce)
}

/// The email of an ID token issued to `client_id` for `nonce`.
pub fn id_token_email(id_token: &str, client_id: &str, nonce: &str) -> Result<String, AuthError> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        aud: serde_json::Value,
        nonce: Option<String>,
        email: Option<String>,
    }
    let bad = || AuthError::Provider("ChatGPT's answer didn't match the sign-in.".into());
    let raw: Raw = id_token
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(bad)?;
    let audience = match &raw.aud {
        serde_json::Value::String(aud) => aud == client_id,
        serde_json::Value::Array(auds) => auds.iter().any(|aud| aud == client_id),
        _ => false,
    };
    if !audience || raw.nonce.as_deref() != Some(nonce) {
        return Err(bad());
    }
    raw.email
        .ok_or_else(|| AuthError::Provider("ChatGPT didn't say who signed in.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_token(claims: serde_json::Value) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        format!("e30.{payload}.sig")
    }

    fn tokens(scope: &str, id_token: String) -> TokenResponse {
        TokenResponse {
            access_token: "a".into(),
            expires_in: Some(3600),
            refresh_token: Some("r".into()),
            scope: Some(scope.into()),
            id_token: Some(id_token),
        }
    }

    #[test]
    fn asks_for_the_plan_on_a_loopback_address() {
        let url = authorize_url(&Authorize {
            client_id: NEW_CLIENT,
            redirect_uri: &redirect_uri(4711),
            challenge: "ch",
            state: "st",
            nonce: "no",
            host_id: "urn:uuid:1",
        });
        let url = url::Url::parse(&url).unwrap();
        let params: std::collections::HashMap<String, String> =
            url.query_pairs().into_owned().collect();
        assert!(url.as_str().starts_with(AUTHORIZE));
        assert_eq!(params["client_id"], "dynamic_agent_client");
        assert_eq!(
            params["redirect_uri"],
            "http://127.0.0.1:4711/auth/callback"
        );
        assert!(params["scope"].split(' ').any(|s| s == PLAN_SCOPE));
        assert!(params["scope"].split(' ').any(|s| s == "offline_access"));
        assert_eq!(params["resource"], API);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["state"], "st");
        assert_eq!(params["nonce"], "no");
        assert_eq!(params["agent_name_hint"], "action0");
        assert_eq!(params["ext_agent_host_id"], "urn:uuid:1");
    }

    #[test]
    fn makes_a_uuid_for_the_install() {
        let id = new_host_id();
        assert_eq!(id.len(), "urn:uuid:".len() + 36);
        assert_eq!(&id[9 + 14..9 + 15], "4");
        assert_ne!(id, new_host_id());
    }

    #[test]
    fn redeems_and_renews_for_the_api() {
        let form = code_form("oaiapp_1", "c", "v", "http://127.0.0.1:1/auth/callback");
        assert!(form.contains(&("client_id", "oaiapp_1".into())));
        assert!(form.contains(&("code_verifier", "v".into())));
        assert!(form.contains(&("resource", API.into())));
        let form = refresh_form("oaiapp_1", "r");
        assert!(form.contains(&("grant_type", "refresh_token".into())));
        assert!(form.contains(&("refresh_token", "r".into())));
    }

    #[test]
    fn needs_the_plan_scope() {
        let token = id_token(serde_json::json!({"aud": "c", "nonce": "n", "email": "a@b.c"}));
        assert_eq!(
            signed_in(&tokens("openid email", token.clone()), "c", "n"),
            Err(AuthError::Denied(
                "Using the ChatGPT plan wasn't allowed.".into()
            ))
        );
        assert_eq!(
            signed_in(&tokens("openid chatgpt.tokens.use.direct", token), "c", "n"),
            Ok("a@b.c".into())
        );
    }

    #[test]
    fn checks_the_id_token_is_for_this_sign_in() {
        let token =
            id_token(serde_json::json!({"aud": ["x", "c"], "nonce": "n", "email": "a@b.c"}));
        assert_eq!(id_token_email(&token, "c", "n"), Ok("a@b.c".into()));
        assert!(id_token_email(&token, "other", "n").is_err());
        assert!(id_token_email(&token, "c", "replayed").is_err());
        assert!(id_token_email("garbage", "c", "n").is_err());
    }
}
