//! Signing in at OpenRouter (PKCE): the browser comes back with a code,
//! which is exchanged for an API key billed to the user's OpenRouter
//! credit. The key is kept like any other; it never reaches the UI.

use serde::Deserialize;

pub const AUTH: &str = "https://openrouter.ai/auth";
pub const KEYS: &str = "https://openrouter.ai/api/v1/auth/keys";
/// Where the key may be sent.
pub const API: &str = "https://openrouter.ai/api/v1";
/// Where the browser comes back to.
pub const CALLBACK_PATH: &str = "/callback";

/// The loopback address the browser comes back to (`localhost` works on any port).
pub fn callback_url(port: u16) -> String {
    format!("http://localhost:{port}{CALLBACK_PATH}")
}

/// The sign-in page's address.
pub fn auth_url(callback: &str, challenge: &str) -> String {
    url::Url::parse_with_params(
        AUTH,
        &[
            ("callback_url", callback),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .expect("the auth URL parses")
    .to_string()
}

/// What the code is exchanged with.
pub fn exchange_body(code: &str, verifier: &str) -> serde_json::Value {
    serde_json::json!({
        "code": code,
        "code_verifier": verifier,
        "code_challenge_method": "S256",
    })
}

/// The exchange's answer.
#[derive(Debug, Deserialize)]
pub struct KeyAnswer {
    pub key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_with_a_challenge_and_comes_back_here() {
        let url = url::Url::parse(&auth_url(&callback_url(4711), "ch")).unwrap();
        let params: std::collections::HashMap<String, String> =
            url.query_pairs().into_owned().collect();
        assert_eq!(params["callback_url"], "http://localhost:4711/callback");
        assert_eq!(params["code_challenge"], "ch");
        assert_eq!(params["code_challenge_method"], "S256");
    }

    #[test]
    fn exchanges_the_code_with_the_verifier() {
        assert_eq!(
            exchange_body("c", "v"),
            serde_json::json!({"code": "c", "code_verifier": "v", "code_challenge_method": "S256"})
        );
    }
}
