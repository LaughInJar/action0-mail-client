//! PKCE (RFC 7636) and the `state` value of a sign-in.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// A random URL-safe value of `bytes` random bytes.
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

/// The verifier the app keeps, and the challenge it sends first.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Default for Pkce {
    /// A new pair, S256.
    fn default() -> Self {
        // 32 random bytes are 43 characters: the shortest verifier allowed.
        Self::from_verifier(random_token(32))
    }
}

impl Pkce {
    /// A new pair, S256.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_example() {
        // RFC 7636, appendix B.
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn makes_valid_verifiers() {
        let pkce = Pkce::new();
        assert_eq!(pkce.verifier.len(), 43);
        assert!(
            pkce.verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_ne!(Pkce::new().verifier, pkce.verifier);
    }
}
