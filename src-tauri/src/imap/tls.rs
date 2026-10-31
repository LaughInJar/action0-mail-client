//! TLS for mail servers. Certificates are checked like the system checks
//! them (desktop: the platform's verifier; Android: Mozilla's roots, as in
//! `net.rs`). An account may trust one certificate the system refuses
//! (self-hosted servers), pinned by its SHA-256: that certificate is then
//! accepted whatever its name or issuer, TLS signatures still checked;
//! any other certificate the system refuses is refused, never trusted on
//! its own. A refusal comes with the certificate's details, so the user can
//! decide on it.
//!
//! Like Thunderbird's exceptions, the pin only adds to what the system
//! trusts: a server that gets a proper certificate later keeps working, and
//! an account's SMTP server on another host with a valid certificate needs
//! no pin of its own.
//!
//! [`client_config`] gives the same checks as a rustls configuration, for
//! HTTPS clients (calendar servers), with a [`Seen`] handle that tells
//! what the last handshake saw.

use std::sync::{Arc, Mutex, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use super::error::{MailServerCertificate, MailServerError, ServerRole};

/// rustls with ring, as everywhere in the app.
pub fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| Arc::new(rustls::crypto::ring::default_provider()))
        .clone()
}

/// The system's certificate checks, made once (loading the roots takes a moment).
pub fn system_verifier() -> Result<Arc<dyn ServerCertVerifier>, MailServerError> {
    static SYSTEM: OnceLock<Result<Arc<dyn ServerCertVerifier>, String>> = OnceLock::new();
    SYSTEM
        .get_or_init(make_system_verifier)
        .clone()
        .map_err(|message| MailServerError::tls(format!("No certificate checks: {message}")))
}

#[cfg(desktop)]
fn make_system_verifier() -> Result<Arc<dyn ServerCertVerifier>, String> {
    rustls_platform_verifier::Verifier::new(provider())
        .map(|verifier| Arc::new(verifier) as Arc<dyn ServerCertVerifier>)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn make_system_verifier() -> Result<Arc<dyn ServerCertVerifier>, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
        .build()
        .map(|verifier| verifier as Arc<dyn ServerCertVerifier>)
        .map_err(|error| error.to_string())
}

/// A certificate's SHA-256 as it's shown and kept: `AB:CD:…`.
pub fn fingerprint(der: &[u8]) -> String {
    format_fingerprint(&Sha256::digest(der))
}

/// Hash bytes as upper-case hex, colon-separated.
pub fn format_fingerprint(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A fingerprint as the user or the vault gives it (colons and spaces
/// optional, any case); `None` if it isn't a SHA-256.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-'))
        .collect();
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(bytes)
}

/// What a handshake saw.
#[derive(Debug, Default)]
struct Saw {
    /// The server's (end-entity) certificate.
    certificate: Option<CertificateDer<'static>>,
    /// The system refused it, and it isn't the pinned one.
    refused: bool,
    /// It was let in because it's the pinned one.
    pinned: bool,
}

/// Checks a server's certificate: the pinned one is accepted, anything else
/// goes to the system's checks. Remembers what it saw.
#[derive(Debug)]
struct Verifier {
    system: Arc<dyn ServerCertVerifier>,
    pin: Option<[u8; 32]>,
    seen: Arc<Mutex<Saw>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let mut seen = self.seen.lock().expect("tls lock");
        seen.certificate = Some(end_entity.clone().into_owned());
        if self
            .pin
            .is_some_and(|pin| Sha256::digest(end_entity.as_ref()).as_slice() == pin)
        {
            seen.pinned = true;
            return Ok(ServerCertVerified::assertion());
        }
        let verdict = self.system.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        );
        seen.refused = verdict.is_err();
        verdict
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// What the handshakes of a configuration saw (the last one), to tell a
/// refused certificate from other failures.
#[derive(Clone, Debug, Default)]
pub struct Seen(Arc<Mutex<Saw>>);

impl Seen {
    /// The `untrusted` error for a certificate the checks refused.
    pub fn refusal(&self, server: ServerRole) -> Option<MailServerError> {
        let seen = self.0.lock().expect("tls lock");
        if !seen.refused {
            return None;
        }
        let certificate = details(seen.certificate.as_ref()?, server);
        let mut error = MailServerError::new(
            super::error::ErrorKind::Untrusted,
            format!(
                "The certificate of the {} server isn't trusted.",
                match server {
                    ServerRole::Imap => "IMAP",
                    ServerRole::Smtp => "SMTP",
                    ServerRole::Caldav => "calendar",
                    ServerRole::Sieve => "filter",
                }
            ),
        )
        .on(server);
        error.certificate = Some(Box::new(certificate));
        Some(error)
    }

    /// True if the handshake got through because of the pinned certificate.
    pub fn used_pin(&self) -> bool {
        self.0.lock().expect("tls lock").pinned
    }
}

/// TLS settings (TLS 1.2 or later) with the system's checks plus `pin`,
/// and what their handshakes see.
pub fn client_config(pin: Option<&str>) -> Result<(ClientConfig, Seen), MailServerError> {
    client_config_with(system_verifier()?, pin)
}

/// The same with other checks than the system's (tests: their own CA).
pub fn client_config_with(
    system: Arc<dyn ServerCertVerifier>,
    pin: Option<&str>,
) -> Result<(ClientConfig, Seen), MailServerError> {
    let pin = match pin {
        Some(text) => Some(parse_fingerprint(text).ok_or_else(|| {
            MailServerError::tls("The trusted certificate isn't a SHA-256 fingerprint.")
        })?),
        None => None,
    };
    let seen = Seen::default();
    let verifier = Verifier {
        system,
        pin,
        seen: seen.0.clone(),
        provider: provider(),
    };
    let config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|error| MailServerError::tls(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok((config, seen))
}

/// TLS for one connection (TLS 1.2 or later), and what its handshake saw.
pub struct Connector {
    connector: TlsConnector,
    seen: Seen,
}

impl Connector {
    /// The system's checks, plus the account's pinned certificate if any.
    pub fn new(pin: Option<&str>) -> Result<Self, MailServerError> {
        Self::with_verifier(system_verifier()?, pin)
    }

    /// The same with other checks than the system's (tests: their own CA).
    pub fn with_verifier(
        system: Arc<dyn ServerCertVerifier>,
        pin: Option<&str>,
    ) -> Result<Self, MailServerError> {
        let (config, seen) = client_config_with(system, pin)?;
        Ok(Self {
            connector: TlsConnector::from(Arc::new(config)),
            seen,
        })
    }

    /// The TLS handshake with `host` over `stream`. A certificate the checks
    /// refuse is `untrusted`, with its details; anything else that fails is `tls`.
    pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        host: &str,
        stream: S,
        server: ServerRole,
    ) -> Result<TlsStream<S>, MailServerError> {
        let name = ServerName::try_from(host.to_string())
            .map_err(|_| MailServerError::unreachable(format!("“{host}” isn't a server name.")))?;
        match self.connector.connect(name, stream).await {
            Ok(stream) => Ok(stream),
            Err(error) => Err(self.seen.refusal(server).unwrap_or_else(|| {
                MailServerError::tls(format!("TLS didn't work out: {error}")).on(server)
            })),
        }
    }

    /// True if the handshake got through because of the pinned certificate.
    pub fn used_pin(&self) -> bool {
        self.seen.used_pin()
    }
}

/// A certificate's details for the user (what x509-parser can read of it).
pub fn details(der: &[u8], server: ServerRole) -> MailServerCertificate {
    let mut certificate = MailServerCertificate {
        sha256: fingerprint(der),
        subject: String::new(),
        issuer: String::new(),
        not_before: String::new(),
        not_after: String::new(),
        names: Vec::new(),
        server,
    };
    let Ok((_, parsed)) = x509_parser::parse_x509_certificate(der) else {
        return certificate;
    };
    certificate.subject = parsed.subject().to_string();
    certificate.issuer = parsed.issuer().to_string();
    certificate.not_before = iso8601(parsed.validity().not_before.timestamp());
    certificate.not_after = iso8601(parsed.validity().not_after.timestamp());
    if let Ok(Some(names)) = parsed.subject_alternative_name() {
        use x509_parser::extensions::GeneralName;
        for name in &names.value.general_names {
            match name {
                GeneralName::DNSName(dns) => certificate.names.push(dns.to_string()),
                GeneralName::IPAddress(bytes) => {
                    if let Some(address) = ip_address(bytes) {
                        certificate.names.push(address);
                    }
                }
                _ => {}
            }
        }
    }
    if certificate.names.is_empty() {
        certificate.names = parsed
            .subject()
            .iter_common_name()
            .filter_map(|name| name.as_str().ok().map(str::to_string))
            .collect();
    }
    certificate
}

fn ip_address(bytes: &[u8]) -> Option<String> {
    match bytes.len() {
        4 => Some(std::net::Ipv4Addr::from(<[u8; 4]>::try_from(bytes).ok()?).to_string()),
        16 => Some(std::net::Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?).to_string()),
        _ => None,
    }
}

/// Seconds since 1970 as ISO 8601 (UTC).
pub fn iso8601(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::testing::{self, TestCa};

    #[test]
    fn writes_and_reads_fingerprints() {
        let print = fingerprint(b"hello");
        assert_eq!(print.len(), 32 * 3 - 1);
        assert!(print.starts_with("2C:F2:4D:BA"));
        let bytes = parse_fingerprint(&print).unwrap();
        assert_eq!(
            parse_fingerprint(&print.to_lowercase().replace(':', "")),
            Some(bytes)
        );
        assert_eq!(parse_fingerprint("AB:CD"), None);
        assert_eq!(parse_fingerprint(&"zz".repeat(32)), None);
    }

    #[test]
    fn writes_dates_as_iso() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_793_046_896), "2026-10-26T20:34:56Z");
        assert_eq!(iso8601(-86_400), "1969-12-31T00:00:00Z");
    }

    #[test]
    fn describes_a_certificate() {
        let (der, _) = testing::self_signed(&["mail.example.org", "127.0.0.1"]);
        let certificate = details(&der, ServerRole::Smtp);
        assert_eq!(certificate.sha256, fingerprint(&der));
        assert!(certificate.subject.contains("CN=mail.example.org"));
        assert_eq!(certificate.subject, certificate.issuer);
        assert_eq!(certificate.names, ["mail.example.org", "127.0.0.1"]);
        assert!(certificate.not_before.ends_with('Z'));
        assert_eq!(certificate.server, ServerRole::Smtp);
    }

    /// A handshake against a test server with `cert`; the connector's result.
    async fn handshake(
        connector: &Connector,
        cert: (Vec<u8>, Vec<u8>),
    ) -> Result<(), MailServerError> {
        let acceptor = testing::acceptor(cert);
        let (client, server) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move { acceptor.accept(server).await.map(|_| ()) });
        let result = connector
            .handshake("mail.example.org", client, ServerRole::Imap)
            .await
            .map(|_| ());
        let _ = server.await;
        result
    }

    #[tokio::test]
    async fn refuses_an_unknown_certificate_with_its_details() {
        let ca = TestCa::new();
        let unknown = testing::self_signed(&["mail.example.org"]);
        let connector = Connector::with_verifier(ca.verifier(), None).unwrap();
        let error = handshake(&connector, unknown.clone()).await.unwrap_err();
        assert_eq!(error.kind, super::super::error::ErrorKind::Untrusted);
        assert_eq!(error.server, Some(ServerRole::Imap));
        let certificate = error.certificate.unwrap();
        assert_eq!(certificate.sha256, fingerprint(&unknown.0));
        assert_eq!(certificate.server, ServerRole::Imap);
    }

    #[tokio::test]
    async fn accepts_what_the_system_trusts() {
        let ca = TestCa::new();
        let connector = Connector::with_verifier(ca.verifier(), None).unwrap();
        handshake(&connector, ca.issue("mail.example.org"))
            .await
            .unwrap();
        assert!(!connector.used_pin());
        // A pin for another certificate doesn't get in the way.
        let other = fingerprint(&testing::self_signed(&["x"]).0);
        let connector = Connector::with_verifier(ca.verifier(), Some(&other)).unwrap();
        handshake(&connector, ca.issue("mail.example.org"))
            .await
            .unwrap();
        assert!(!connector.used_pin());
        // Nor does a wrong name stay unnoticed.
        let connector = Connector::with_verifier(ca.verifier(), None).unwrap();
        let error = handshake(&connector, ca.issue("other.example.org"))
            .await
            .unwrap_err();
        assert!(error.certificate.is_some());
    }

    #[tokio::test]
    async fn accepts_only_the_pinned_certificate() {
        let ca = TestCa::new();
        // Another name than the host's: the pin doesn't care.
        let pinned = testing::self_signed(&["localhost"]);
        let pin = fingerprint(&pinned.0);
        let connector = Connector::with_verifier(ca.verifier(), Some(&pin)).unwrap();
        handshake(&connector, pinned).await.unwrap();
        assert!(connector.used_pin());

        // A different untrusted certificate is refused, with its details.
        let changed = testing::self_signed(&["mail.example.org"]);
        let connector = Connector::with_verifier(ca.verifier(), Some(&pin)).unwrap();
        let error = handshake(&connector, changed.clone()).await.unwrap_err();
        assert_eq!(error.certificate.unwrap().sha256, fingerprint(&changed.0));
        assert!(!connector.used_pin());
    }

    #[test]
    fn refuses_a_pin_that_isnt_one() {
        let ca = TestCa::new();
        assert_eq!(
            Connector::with_verifier(ca.verifier(), Some("AB:CD"))
                .err()
                .unwrap()
                .kind,
            super::super::error::ErrorKind::Tls
        );
    }
}
