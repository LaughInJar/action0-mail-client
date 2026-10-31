use std::sync::Arc;

use reqwest::Method;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

use super::http::{self, Authorizer, Outgoing};
use super::*;
use crate::imap::ErrorKind;
use crate::imap::testing::{self, TestCa};
use crate::vault::FixedKey;

fn dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("action0-caldav-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn states(name: &str) -> (Imap, Caldav) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = dir(name);
    let key = Arc::new(FixedKey(vec![7; 32]));
    (
        Imap::new(
            crate::net::http_client(),
            LazyVault::new(dir.join("imap.vault"), key.clone()),
        ),
        Caldav::new(LazyVault::new(dir.join("caldav.vault"), key)),
    )
}

const BASIC: &str = "Basic bWU6c2VjcmV0"; // me:secret

fn multistatus(props: &str) -> ResponseTemplate {
    ResponseTemplate::new(207)
        .insert_header("content-type", "application/xml; charset=utf-8")
        .set_body_string(format!(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
        ))
}

/// A server whose `.well-known` leads to `/dav/`, with a principal, a
/// home, a calendar address and scheduling.
async fn calendar_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("PROPFIND"))
        .and(path("/.well-known/caldav"))
        .respond_with(ResponseTemplate::new(301).insert_header("location", "/dav/"))
        .mount(&server)
        .await;
    Mock::given(method("PROPFIND"))
        .and(path("/dav/"))
        .and(header("authorization", BASIC))
        .and(header("depth", "0"))
        .respond_with(multistatus(
            "<d:current-user-principal><d:href>/dav/principals/me/</d:href></d:current-user-principal>",
        ))
        .mount(&server)
        .await;
    Mock::given(method("PROPFIND"))
        .and(path("/dav/principals/me/"))
        .and(header("authorization", BASIC))
        .respond_with(multistatus(
            "<c:calendar-home-set><d:href>/dav/calendars/me/</d:href></c:calendar-home-set>\
             <c:calendar-user-address-set><d:href>/dav/principals/me/</d:href><d:href>mailto:me@example.org</d:href></c:calendar-user-address-set>",
        ))
        .mount(&server)
        .await;
    Mock::given(method("OPTIONS"))
        .and(path("/dav/calendars/me/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("dav", "1, 3, calendar-access, calendar-auto-schedule"),
        )
        .mount(&server)
        .await;
    server
}

fn setup(urls: Vec<String>, password: &str) -> Setup {
    Setup {
        key: None,
        label: Some(" Home ".into()),
        urls,
        login: SetupLogin::Password {
            username: "me".into(),
            password: password.into(),
        },
        trust: None,
    }
}

#[test]
fn sends_logins_only_to_the_servers_hosts() {
    let hosts = vec!["https://dav.example.org:443".to_string()];
    let ok = |url: &str| http::allowed(&Url::parse(url).unwrap(), &hosts);
    assert!(ok("https://dav.example.org/cal/x.ics"));
    assert!(ok("https://DAV.example.org:443/"));
    assert!(!ok("http://dav.example.org/"));
    assert!(!ok("https://dav.example.org:8443/"));
    assert!(!ok("https://evil.example.org/"));
    assert!(!ok("https://user@dav.example.org/"));
    assert!(!ok("file:///etc/passwd"));
}

#[tokio::test]
async fn finds_the_calendars_from_the_server_address() {
    let server = calendar_server().await;
    let (imap, caldav) = states("find");
    // A bare address is also tried at its `.well-known`, which redirects.
    let info = caldav
        .connect(&imap, setup(vec![format!("{}/", server.uri())], "secret"))
        .await
        .unwrap();
    assert!(info.key.starts_with("caldav:"));
    assert_eq!(info.label, "Home");
    assert_eq!(
        info.principal,
        format!("{}/dav/principals/me/", server.uri())
    );
    assert_eq!(info.home, format!("{}/dav/calendars/me/", server.uri()));
    assert_eq!(info.address.as_deref(), Some("me@example.org"));
    assert_eq!(info.username, "me");
    assert!(!info.same_as_mail);
    assert!(info.scheduling);
    assert!(!info.pinned);
    let kept = caldav.server(&info.key).unwrap();
    assert_eq!(
        kept.hosts,
        [origin_of(&server.uri())],
        "the login may go back there"
    );
    assert_eq!(
        serde_json::to_value(&info).unwrap()["sameAsMail"],
        serde_json::json!(false)
    );
}

fn origin_of(uri: &str) -> String {
    http::origin(&Url::parse(uri).unwrap()).unwrap()
}

#[tokio::test]
async fn says_when_the_login_is_refused_or_nothing_is_there() {
    let server = calendar_server().await;
    let (imap, caldav) = states("refused");
    let error = caldav
        .connect(
            &imap,
            setup(vec![format!("{}/dav/", server.uri())], "wrong"),
        )
        .await
        .unwrap_err();
    // wiremock answers 404 to the wrong login (no mock matches it)…
    assert_eq!(error.kind, ErrorKind::NotFound);
    assert_eq!(error.server, Some(ServerRole::Caldav));

    let refusing = MockServer::start().await;
    Mock::given(method("PROPFIND"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&refusing)
        .await;
    let error = caldav
        .connect(
            &imap,
            setup(
                vec![format!("{}/dav/", server.uri()), refusing.uri()],
                "wrong",
            ),
        )
        .await
        .unwrap_err();
    // …and a refusal is the more telling of the two.
    assert_eq!(error.kind, ErrorKind::Auth);
    assert!(caldav.vault().all().is_empty());
}

#[tokio::test]
async fn shares_the_mail_accounts_login() {
    let server = calendar_server().await;
    let (imap, caldav) = states("same");
    let error = caldav
        .connect(
            &imap,
            Setup {
                key: Some("imap:me@example.org".into()),
                label: None,
                urls: vec![format!("{}/dav/", server.uri())],
                login: SetupLogin::SameAsMail { same_as_mail: true },
                trust: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);

    imap.vault().put(
        "imap:me@example.org",
        crate::imap::ImapAccount {
            address: "me@example.org".into(),
            name: "Me".into(),
            settings: crate::imap::MailServerSettings {
                imap: crate::imap::MailServer {
                    host: "imap.example.org".into(),
                    port: 993,
                    security: crate::imap::Security::Tls,
                },
                smtp: crate::imap::MailServer {
                    host: "smtp.example.org".into(),
                    port: 465,
                    security: crate::imap::Security::Tls,
                },
                username: "me".into(),
            },
            auth: crate::imap::ImapAuth::Password {
                password: "secret".into(),
            },
            pinned: None,
            max_bytes: None,
        },
    );
    let info = caldav
        .connect(
            &imap,
            Setup {
                key: Some("imap:me@example.org".into()),
                label: None,
                urls: vec![format!("{}/dav/", server.uri())],
                login: SetupLogin::SameAsMail { same_as_mail: true },
                trust: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(info.key, "imap:me@example.org");
    assert_eq!(info.label, "me@example.org");
    assert!(info.same_as_mail);
    assert_eq!(info.username, "");
    // Removing the server forgets the login.
    caldav.remove("imap:me@example.org");
    assert!(caldav.server("imap:me@example.org").is_err());
}

#[tokio::test]
async fn adds_its_own_login_and_follows_redirects_only_on_the_servers_hosts() {
    let server = calendar_server().await;
    let elsewhere = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("leaked"))
        .mount(&elsewhere)
        .await;
    Mock::given(method("PUT"))
        .and(path("/dav/calendars/me/home/a.ics"))
        .and(header("authorization", BASIC))
        .and(header("if-none-match", "*"))
        .respond_with(ResponseTemplate::new(201).insert_header("etag", "\"1\""))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/dav/moved"))
        .respond_with(ResponseTemplate::new(308).insert_header("location", "/dav/calendars/me/"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/dav/calendars/me/"))
        .and(header("authorization", BASIC))
        .respond_with(ResponseTemplate::new(200).set_body_string("home"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/dav/away"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", format!("{}/x", elsewhere.uri())),
        )
        .mount(&server)
        .await;

    let (imap, caldav) = states("request");
    let info = caldav
        .connect(
            &imap,
            setup(vec![format!("{}/dav/", server.uri())], "secret"),
        )
        .await
        .unwrap();
    let request = |method: &str, url: String, headers: Vec<(String, String)>| RequestMeta {
        key: info.key.clone(),
        id: 1,
        method: method.into(),
        url,
        headers,
    };

    // The UI's Authorization is replaced with the login's.
    let answer = caldav
        .request(
            &imap,
            &request(
                "PUT",
                format!("{}/dav/calendars/me/home/a.ics", server.uri()),
                vec![
                    ("Authorization".into(), "Bearer stolen".into()),
                    ("If-None-Match".into(), "*".into()),
                    ("Content-Type".into(), "text/calendar".into()),
                ],
            ),
            b"BEGIN:VCALENDAR".to_vec(),
        )
        .await
        .unwrap();
    assert_eq!(answer.status, 201);
    assert_eq!(answer.header("ETag"), Some("\"1\""));

    // Redirects on the server's hosts are followed, with the final address.
    let answer = caldav
        .request(
            &imap,
            &request("GET", format!("{}/dav/moved", server.uri()), Vec::new()),
            Vec::new(),
        )
        .await
        .unwrap();
    assert_eq!(answer.status, 200);
    assert_eq!(answer.url.path(), "/dav/calendars/me/");
    let framed = frame(&answer.meta(), &answer.body);
    let length = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
    let meta: serde_json::Value = serde_json::from_slice(&framed[4..4 + length]).unwrap();
    assert_eq!(
        meta["url"],
        format!("{}/dav/calendars/me/", server.uri()).as_str()
    );
    assert_eq!(&framed[4 + length..], b"home");

    // Elsewhere, they come back as they are.
    let answer = caldav
        .request(
            &imap,
            &request("GET", format!("{}/dav/away", server.uri()), Vec::new()),
            Vec::new(),
        )
        .await
        .unwrap();
    assert_eq!(answer.status, 302);
    assert!(elsewhere.received_requests().await.unwrap().is_empty());

    // And nothing at all goes to another host.
    let error = caldav
        .request(
            &imap,
            &request("GET", format!("{}/x", elsewhere.uri()), Vec::new()),
            Vec::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Server);
    let unknown = RequestMeta {
        key: "caldav:nope".into(),
        ..request("GET", server.uri(), Vec::new())
    };
    assert_eq!(
        caldav
            .request(&imap, &unknown, Vec::new())
            .await
            .unwrap_err()
            .kind,
        ErrorKind::NotFound
    );
    let sent: Vec<MockRequest> = server.received_requests().await.unwrap();
    assert!(
        sent.iter()
            .all(|request| request.headers.get("authorization").unwrap() == BASIC)
    );
}

#[test]
fn reads_the_request_header() {
    let meta = parse_meta(
        "%7B%22key%22%3A%22caldav%3Aa%22%2C%22id%22%3A3%2C%22method%22%3A%22REPORT%22%2C%22url%22%3A%22https%3A%2F%2Fx%2F%22%2C%22headers%22%3A%5B%5B%22Depth%22%2C%221%22%5D%5D%7D",
    )
    .unwrap();
    assert_eq!(
        meta,
        RequestMeta {
            key: "caldav:a".into(),
            id: 3,
            method: "REPORT".into(),
            url: "https://x/".into(),
            headers: vec![("Depth".into(), "1".into())],
        }
    );
    assert!(
        format!(
            "{:?}",
            Login::Password {
                username: "me".into(),
                password: "secret".into()
            }
        )
        .find("secret")
        .is_none()
    );
}

/// A one-request HTTPS server with `cert`; its address.
async fn https_once(cert: (Vec<u8>, Vec<u8>)) -> String {
    let acceptor = testing::acceptor(cert);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let mut buffer = vec![0u8; 4096];
                let _ = tls.read(&mut buffer).await;
                let _ = tls
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
                let _ = tls.shutdown().await;
            });
        }
    });
    format!("https://127.0.0.1:{}/", address.port())
}

#[tokio::test]
async fn trusts_only_the_pinned_certificate() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let ca = TestCa::new();
    let cert = testing::self_signed(&["127.0.0.1"]);
    let pin = crate::imap::tls::fingerprint(&cert.0);
    let url = https_once(cert).await;
    let get = Outgoing {
        method: Method::GET,
        url: Url::parse(&url).unwrap(),
        headers: Vec::new(),
        body: Vec::new(),
    };

    let (config, seen) = crate::imap::tls::client_config_with(ca.verifier(), None).unwrap();
    let client = http::client(config).unwrap();
    let error = http::send(&client, &seen, &get, None, &|_| false)
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Untrusted);
    assert_eq!(error.server, Some(ServerRole::Caldav));
    let certificate = error.certificate.unwrap();
    assert_eq!(certificate.sha256, pin);
    assert_eq!(certificate.server, ServerRole::Caldav);
    assert_eq!(
        serde_json::to_value(&*certificate).unwrap()["server"],
        "caldav"
    );

    let (config, seen) = crate::imap::tls::client_config_with(ca.verifier(), Some(&pin)).unwrap();
    let client = http::client(config).unwrap();
    let answer = http::send(&client, &seen, &get, None, &|_| false)
        .await
        .unwrap();
    assert_eq!(answer.status, 200);
    assert_eq!(answer.body, b"ok");
    assert!(seen.used_pin());
}

#[tokio::test]
async fn authorizes_with_a_password() {
    let (imap, _) = states("authorize");
    let login = Login::Password {
        username: "me".into(),
        password: "secret".into(),
    };
    let mut authorizer = Authorizer::new(&imap, "caldav:x", &login);
    assert_eq!(authorizer.header().await.unwrap(), BASIC);
    // Nothing to renew: a refused password stays refused.
    assert!(!authorizer.renew().await.unwrap());
}
