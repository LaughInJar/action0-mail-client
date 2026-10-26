//! Yahoo and AOL sign-in for IMAP and SMTP (XOAUTH2/OAUTHBEARER): the
//! browser with PKCE and `state`, coming back to a loopback address, scope
//! `mail-w`, with the app's own registration (the UI sends its client id,
//! and the secret if the registration has one). Refresh tokens rotate and
//! are kept in the vault; access tokens stay in memory.

use super::account::OAuthProvider;
use crate::oauth::providers::Client;

/// The scope that allows reading and sending mail.
pub const SCOPE: &str = "mail-w";
/// Where the browser comes back to.
pub const CALLBACK_PATH: &str = "/";
/// The app's link an Android sign-in tab comes back to (`msauth://<package>/…`).
pub const AUTH_TAB_LINK: &str = "action0-imap";

/// The loopback redirect for `port`.
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

impl OAuthProvider {
    fn base(self) -> &'static str {
        match self {
            Self::Yahoo => "https://api.login.yahoo.com/oauth2",
            Self::Aol => "https://api.login.aol.com/oauth2",
        }
    }

    pub fn token_endpoint(self) -> String {
        format!("{}/get_token", self.base())
    }

    /// The sign-in page's address.
    pub fn authorize_url(
        self,
        client: &Client,
        redirect_uri: &str,
        challenge: &str,
        state: &str,
    ) -> String {
        url::Url::parse_with_params(
            &format!("{}/request_auth", self.base()),
            &[
                ("client_id", client.id.as_str()),
                ("redirect_uri", redirect_uri),
                ("response_type", "code"),
                ("scope", SCOPE),
                ("state", state),
                ("code_challenge", challenge),
                ("code_challenge_method", "S256"),
            ],
        )
        .expect("the authorize URL parses")
        .into()
    }

    /// The form that redeems a code.
    pub fn code_form(
        self,
        client: &Client,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Vec<(&'static str, String)> {
        with_secret(
            vec![
                ("client_id", client.id.clone()),
                ("grant_type", "authorization_code".into()),
                ("code", code.into()),
                ("code_verifier", verifier.into()),
                ("redirect_uri", redirect_uri.into()),
            ],
            client,
        )
    }

    /// The form that renews an access token.
    pub fn refresh_form(self, client: &Client, refresh_token: &str) -> Vec<(&'static str, String)> {
        with_secret(
            vec![
                ("client_id", client.id.clone()),
                ("grant_type", "refresh_token".into()),
                ("refresh_token", refresh_token.into()),
            ],
            client,
        )
    }
}

/// Adds the client secret, if the registration has one.
fn with_secret(
    mut form: Vec<(&'static str, String)>,
    client: &Client,
) -> Vec<(&'static str, String)> {
    if let Some(secret) = client.secret.as_ref().filter(|s| !s.is_empty()) {
        form.push(("client_secret", secret.clone()));
    }
    form
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn client(secret: Option<&str>) -> Client {
        Client {
            id: "dj0yJmk9".into(),
            secret: secret.map(str::to_string),
        }
    }

    #[test]
    fn builds_the_sign_in_page_address() {
        let url = OAuthProvider::Aol.authorize_url(&client(None), &redirect_uri(4711), "ch", "st");
        let url = url::Url::parse(&url).unwrap();
        assert_eq!(url.host_str(), Some("api.login.aol.com"));
        assert_eq!(url.path(), "/oauth2/request_auth");
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["redirect_uri"], "http://127.0.0.1:4711/");
        assert_eq!(query["scope"], "mail-w");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["state"], "st");
        assert_eq!(query["client_id"], "dj0yJmk9");
        assert_eq!(
            OAuthProvider::Yahoo.token_endpoint(),
            "https://api.login.yahoo.com/oauth2/get_token"
        );
    }

    #[test]
    fn sends_the_secret_only_if_there_is_one() {
        let form = OAuthProvider::Yahoo.code_form(&client(Some("s")), "c", "v", "http://x/");
        assert!(form.contains(&("client_secret", "s".into())));
        assert!(form.contains(&("code_verifier", "v".into())));
        let form = OAuthProvider::Yahoo.refresh_form(&client(Some("")), "r");
        assert!(!form.iter().any(|(key, _)| *key == "client_secret"));
        assert!(form.contains(&("refresh_token", "r".into())));
    }
}
