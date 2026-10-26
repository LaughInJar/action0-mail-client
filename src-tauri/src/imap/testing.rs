//! Test helpers: a scripted server (IMAP or SMTP, line by line, over
//! `tokio::io::duplex` or a socket) and certificates made on the spot.
//!
//! A script is one step per line: `S: <line>` is sent by the server (CRLF
//! added), `C: <line>` must be what the client sends next, exactly. Blank
//! lines and leading spaces don't count.
//!
//! ```ignore
//! let (stream, server) = scripted("
//!     S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready
//!     C: A0001 AUTHENTICATE PLAIN
//!     S: +
//!     C: AHVzZXIAcGFzcw==
//!     S: A0001 OK done
//! ");
//! … // the client side talks over `stream`
//! server.await.unwrap().unwrap(); // the script ran to its end
//! ```

use std::sync::Arc;
use std::time::Duration;

use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair,
};
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::task::JoinHandle;

use super::tls::provider;

/// How long a script waits for the client's next line.
const PATIENCE: Duration = Duration::from_secs(5);

/// One line from the client, without its CRLF (byte by byte, so nothing
/// after it is read: STARTTLS hands the stream over right after).
pub async fn read_line<S: AsyncRead + Unpin>(stream: &mut S) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(PATIENCE, stream.read(&mut byte))
            .await
            .map_err(|_| {
                format!(
                    "the client sent nothing after {:?}",
                    String::from_utf8_lossy(&line)
                )
            })?
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err(format!(
                "the client closed the connection (after {:?})",
                String::from_utf8_lossy(&line)
            ));
        }
        if byte[0] == b'\n' {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(String::from_utf8_lossy(&line).into_owned());
        }
        line.push(byte[0]);
    }
}

/// Plays the server's side of `script` on `stream` (see the module docs).
pub async fn play<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    script: &str,
) -> Result<(), String> {
    for step in script
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.is_empty())
    {
        if let Some(line) = step.strip_prefix("S: ").or(step.strip_prefix("S:")) {
            stream
                .write_all(format!("{line}\r\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            stream.flush().await.map_err(|e| e.to_string())?;
        } else if let Some(expected) = step.strip_prefix("C: ").or(step.strip_prefix("C:")) {
            let line = read_line(stream).await?;
            if line != expected {
                return Err(format!("expected {expected:?}, the client sent {line:?}"));
            }
        } else {
            return Err(format!("not a script step: {step:?}"));
        }
    }
    Ok(())
}

/// A stream for the client whose other end plays `script`; the task says
/// whether the script ran to its end.
pub fn scripted(script: &str) -> (DuplexStream, JoinHandle<Result<(), String>>) {
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    let script = script.to_string();
    let task = tokio::spawn(async move { play(&mut server, &script).await });
    (client, task)
}

/// A session logged in over a scripted server whose capabilities after the
/// login are `capabilities` (without ID or ENABLE, which would be sent; set
/// `enabled` on the session instead), then plays `rest`. Its commands are
/// tagged from `A0003` on.
pub async fn logged_in(
    capabilities: &str,
    rest: &str,
) -> (
    super::session::ImapSession<DuplexStream>,
    JoinHandle<Result<(), String>>,
) {
    use super::account::{MailServer, Security};
    use super::session::{Login, Secret, login_on};
    let (stream, script) = scripted(&format!(
        "
        S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] hi
        C: A0001 AUTHENTICATE PLAIN AHVzZXIAcGFzcw==
        S: A0001 OK in
        C: A0002 CAPABILITY
        S: * CAPABILITY {capabilities}
        S: A0002 OK done
        {rest}"
    ));
    let server = MailServer {
        host: "imap.example.org".into(),
        port: 993,
        security: Security::Tls,
    };
    let login = Login {
        server: &server,
        username: "user",
        secret: Secret::Password("pass"),
    };
    let session = login_on(stream, true, &login).await.expect("logged in");
    (session, script)
}

/// A self-signed certificate for `names` (DNS names or IP addresses):
/// its DER and its key's (PKCS #8).
pub fn self_signed(names: &[&str]) -> (Vec<u8>, Vec<u8>) {
    let key = KeyPair::generate().expect("a key");
    let params = leaf_params(names);
    let cert = params.self_signed(&key).expect("a certificate");
    (cert.der().to_vec(), key.serialize_der())
}

fn leaf_params(names: &[&str]) -> CertificateParams {
    let mut params =
        CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
            .expect("names");
    params
        .distinguished_name
        .push(DnType::CommonName, names.first().copied().unwrap_or("test"));
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params
}

/// A certificate authority of its own: what "the system trusts" in tests.
pub struct TestCa {
    issuer: CertifiedIssuer<'static, KeyPair>,
}

impl TestCa {
    pub fn new() -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).expect("params");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, "action0 test CA");
        let key = KeyPair::generate().expect("a key");
        Self {
            issuer: CertifiedIssuer::self_signed(params, key).expect("a CA"),
        }
    }

    /// A certificate for `name` from this CA: its DER and key.
    pub fn issue(&self, name: &str) -> (Vec<u8>, Vec<u8>) {
        let key = KeyPair::generate().expect("a key");
        let cert = leaf_params(&[name])
            .signed_by(&key, &self.issuer)
            .expect("a certificate");
        (cert.der().to_vec(), key.serialize_der())
    }

    /// Certificate checks that trust this CA only.
    pub fn verifier(&self) -> Arc<dyn ServerCertVerifier> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(self.issuer.der().clone()).expect("the CA");
        rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
            .build()
            .expect("a verifier")
    }
}

/// The server side of TLS with `cert` (DER and key, as above).
pub fn acceptor((cert, key): (Vec<u8>, Vec<u8>)) -> tokio_rustls::TlsAcceptor {
    let config = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
        )
        .expect("a server config");
    tokio_rustls::TlsAcceptor::from(Arc::new(config))
}
