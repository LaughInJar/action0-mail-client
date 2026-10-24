//! What differs between Google and Microsoft: endpoints, parameters, and
//! what their answers mean.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

/// Where an account comes from.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}

/// The app's registration at the provider. Google's desktop clients have
/// a secret, which Google says isn't confidential (it ships with the app).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

/// The client of Google accounts signed in through Play services
/// (Android): no registration in the app, no refresh token.
pub const PLAY_SERVICES: &str = "play-services";

impl Client {
    /// Google through Play services (Android).
    pub fn is_play_services(&self) -> bool {
        self.id == PLAY_SERVICES
    }
}

/// Microsoft's redirect for an Android app: `msauth://<package>/<signature
/// hash>`, the hash (base64 SHA-1 of the signing certificate) URL-encoded,
/// as it's registered in Entra.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn msauth_redirect(package: &str, signature_hash: &str) -> String {
    let hash =
        percent_encoding::utf8_percent_encode(signature_hash, percent_encoding::NON_ALPHANUMERIC);
    format!("msauth://{package}/{hash}")
}

const GOOGLE_AUTHORIZE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE: &str = "https://oauth2.googleapis.com/revoke";
const MICROSOFT_AUTHORIZE: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

impl Provider {
    /// The account id prefix (as the UI names accounts).
    pub fn key_prefix(self) -> &'static str {
        match self {
            Provider::Google => "gmail",
            Provider::Microsoft => "microsoft",
        }
    }

    /// Where the browser comes back to. Microsoft ignores the port of
    /// localhost addresses; the path keeps it apart from the web app's.
    pub fn redirect_uri(self, port: u16) -> String {
        match self {
            Provider::Google => format!("http://127.0.0.1:{port}/"),
            Provider::Microsoft => format!("http://localhost:{port}/desktop"),
        }
    }

    /// The path of [Provider::redirect_uri].
    pub fn redirect_path(self) -> &'static str {
        match self {
            Provider::Google => "/",
            Provider::Microsoft => "/desktop",
        }
    }

    pub fn token_endpoint(self) -> &'static str {
        match self {
            Provider::Google => GOOGLE_TOKEN,
            Provider::Microsoft => MICROSOFT_TOKEN,
        }
    }

    /// Where the browser signs in.
    pub fn authorize_url(self, client: &Client, sign_in: &Authorize<'_>) -> String {
        let Authorize {
            redirect_uri,
            scopes,
            state,
            challenge,
            prompt,
            login_hint,
        } = *sign_in;
        let base = match self {
            Provider::Google => GOOGLE_AUTHORIZE,
            Provider::Microsoft => MICROSOFT_AUTHORIZE,
        };
        let mut url = url::Url::parse(base).expect("authorize endpoint is a URL");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("client_id", &client.id)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", &scopes.join(" "))
                .append_pair("state", state)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("prompt", prompt);
            match self {
                Provider::Google => {
                    query.append_pair("access_type", "offline");
                }
                Provider::Microsoft => {
                    query.append_pair("response_mode", "query");
                }
            }
            if let Some(hint) = login_hint {
                query.append_pair("login_hint", hint);
            }
        }
        url.into()
    }

    /// The form that redeems a code.
    pub fn code_form(
        self,
        client: &Client,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        scopes: &[String],
    ) -> Vec<(&'static str, String)> {
        let mut form = vec![
            ("client_id", client.id.clone()),
            ("grant_type", "authorization_code".into()),
            ("code", code.into()),
            ("code_verifier", verifier.into()),
            ("redirect_uri", redirect_uri.into()),
        ];
        self.add_client_specifics(&mut form, client, scopes);
        form
    }

    /// The form that renews an access token.
    pub fn refresh_form(
        self,
        client: &Client,
        refresh_token: &str,
        scopes: &[String],
    ) -> Vec<(&'static str, String)> {
        let mut form = vec![
            ("client_id", client.id.clone()),
            ("grant_type", "refresh_token".into()),
            ("refresh_token", refresh_token.into()),
        ];
        self.add_client_specifics(&mut form, client, scopes);
        form
    }

    fn add_client_specifics(
        self,
        form: &mut Vec<(&'static str, String)>,
        client: &Client,
        scopes: &[String],
    ) {
        match self {
            // Google wants the (not secret) secret of desktop clients.
            Provider::Google => {
                if let Some(secret) = &client.secret {
                    form.push(("client_secret", secret.clone()));
                }
            }
            // Microsoft wants the scopes again (one resource: Graph).
            Provider::Microsoft => form.push(("scope", scopes.join(" "))),
        }
    }

    /// Where a refresh token is revoked, if the provider has such a place.
    pub fn revoke_endpoint(self) -> Option<&'static str> {
        match self {
            Provider::Google => Some(GOOGLE_REVOKE),
            // Microsoft has none for public clients: forgetting it is all.
            Provider::Microsoft => None,
        }
    }
}

/// What a browser sign-in asks for.
#[derive(Clone, Copy)]
pub struct Authorize<'a> {
    pub redirect_uri: &'a str,
    pub scopes: &'a [String],
    pub state: &'a str,
    pub challenge: &'a str,
    /// `select_account` or `consent`.
    pub prompt: &'a str,
    pub login_hint: Option<&'a str>,
}

/// A token endpoint's answer.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

/// A token endpoint's refusal.
#[derive(Debug, Deserialize)]
pub struct TokenError {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

/// Who signed in, from the ID token (it came straight from the provider
/// over TLS, so its signature isn't checked again).
#[derive(Debug, Default, PartialEq)]
pub struct Claims {
    pub email: Option<String>,
    pub name: Option<String>,
    pub tenant: Option<String>,
}

/// The claims of an ID token.
pub fn claims(id_token: &str) -> Claims {
    #[derive(Deserialize)]
    struct Raw {
        email: Option<String>,
        preferred_username: Option<String>,
        name: Option<String>,
        tid: Option<String>,
    }
    let Some(payload) = id_token.split('.').nth(1) else {
        return Claims::default();
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')) else {
        return Claims::default();
    };
    let Ok(raw) = serde_json::from_slice::<Raw>(&bytes) else {
        return Claims::default();
    };
    Claims {
        email: raw.email.or(raw.preferred_username),
        name: raw.name,
        tenant: raw.tid,
    }
}

/// A scope as providers compare it: Graph's prefix dropped, lower case.
pub fn normal_scope(scope: &str) -> String {
    scope
        .trim_start_matches("https://graph.microsoft.com/")
        .to_ascii_lowercase()
}

/// True if every wanted scope was granted.
pub fn has_scopes(granted: &[String], wanted: &[String]) -> bool {
    let granted: Vec<String> = granted.iter().map(|s| normal_scope(s)).collect();
    wanted
        .iter()
        .all(|scope| granted.contains(&normal_scope(scope)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_microsofts_android_redirect() {
        assert_eq!(
            msauth_redirect("app.action0.mail", "ga0RGNYHvNM5d0SLGQfpQWAPGJ8="),
            "msauth://app.action0.mail/ga0RGNYHvNM5d0SLGQfpQWAPGJ8%3D"
        );
        assert_eq!(
            msauth_redirect("app.action0.mail", "a+b/c="),
            "msauth://app.action0.mail/a%2Bb%2Fc%3D"
        );
    }

    fn client() -> Client {
        Client {
            id: "id-1".into(),
            secret: Some("s3cret".into()),
        }
    }

    #[test]
    fn builds_the_google_sign_in() {
        let scopes = ["https://mail.google.com/".to_string(), "openid".into()];
        let url = Provider::Google.authorize_url(
            &client(),
            &Authorize {
                redirect_uri: "http://127.0.0.1:4711/",
                scopes: &scopes,
                state: "st",
                challenge: "ch",
                prompt: "select_account",
                login_hint: Some("me@example.com"),
            },
        );
        let parsed = url::Url::parse(&url).unwrap();
        let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(parsed.host_str(), Some("accounts.google.com"));
        assert_eq!(query["redirect_uri"], "http://127.0.0.1:4711/");
        assert_eq!(query["scope"], "https://mail.google.com/ openid");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["access_type"], "offline");
        assert_eq!(query["login_hint"], "me@example.com");
        assert!(!query.contains_key("client_secret"));
    }

    #[test]
    fn redeems_codes_the_way_each_provider_wants() {
        let google = Provider::Google.code_form(&client(), "c", "v", "http://127.0.0.1:1/", &[]);
        assert!(google.contains(&("client_secret", "s3cret".into())));
        assert!(!google.iter().any(|(key, _)| *key == "scope"));
        let microsoft = Provider::Microsoft.code_form(
            &Client {
                id: "id".into(),
                secret: None,
            },
            "c",
            "v",
            "http://localhost:1/desktop",
            &["Mail.ReadWrite".into(), "offline_access".into()],
        );
        assert!(microsoft.contains(&("scope", "Mail.ReadWrite offline_access".into())));
        assert!(!microsoft.iter().any(|(key, _)| *key == "client_secret"));
        assert_eq!(
            Provider::Microsoft.redirect_uri(1234),
            "http://localhost:1234/desktop"
        );
    }

    #[test]
    fn reads_who_signed_in() {
        let payload = URL_SAFE_NO_PAD
            .encode(r#"{"preferred_username":"max@contoso.com","name":"Max","tid":"t-1"}"#);
        assert_eq!(
            claims(&format!("x.{payload}.y")),
            Claims {
                email: Some("max@contoso.com".into()),
                name: Some("Max".into()),
                tenant: Some("t-1".into()),
            }
        );
        assert_eq!(claims("garbage"), Claims::default());
    }

    #[test]
    fn compares_scopes_like_the_providers() {
        let granted = vec![
            "https://graph.microsoft.com/Mail.ReadWrite".to_string(),
            "openid".into(),
        ];
        assert!(has_scopes(&granted, &["mail.readwrite".into()]));
        assert!(!has_scopes(&granted, &["Calendars.ReadWrite".into()]));
    }
}
