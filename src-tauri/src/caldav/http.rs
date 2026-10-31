//! Requests to calendar servers: one HTTP client per server (its TLS
//! checks and pin, no cookies, redirects followed here so a login never
//! leaves the server's hosts), failures as [`MailServerError`]s, and the
//! walk from an address to the user's principal and calendar home.

use std::time::Duration;

use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue, LOCATION};
use url::Url;

use super::dav::{self, CALDAV, DAV};
use super::{Login, basic_authorization};
use crate::imap::tls::Seen;
use crate::imap::{ErrorKind, Imap, MailServerError, ServerRole};

/// The most redirects one request follows.
const MAX_REDIRECTS: usize = 5;

/// An HTTP client with these TLS settings: no redirects of its own (see
/// [`send`]), a connect timeout, the app's user agent.
pub fn client(mut config: rustls::ClientConfig) -> Result<reqwest::Client, MailServerError> {
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(120))
        .user_agent(concat!("action0/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| MailServerError::tls(error.to_string()).on(ServerRole::Caldav))
}

/// A URL's origin as kept in a server's hosts: `https://host:443`.
pub fn origin(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    Some(format!(
        "{}://{}:{port}",
        url.scheme(),
        host.to_ascii_lowercase()
    ))
}

/// True if `url` is on one of `hosts` (and is a web address at all).
pub fn allowed(url: &Url, hosts: &[String]) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none()
        && origin(url).is_some_and(|origin| hosts.contains(&origin))
}

/// A request as the UI (or the walk) makes it.
pub struct Outgoing {
    pub method: Method,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// A server's answer.
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// Where it came from, after redirects.
    pub url: Url,
    pub body: Vec<u8>,
}

impl Answer {
    /// A header's value (the first, by lower-case name).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Headers the UI may not set: the login is ours, the rest is the client's.
fn ours(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "cookie"
            | "host"
            | "content-length"
            | "connection"
            | "proxy-authorization"
    )
}

/// Sends `outgoing` with `authorization`, following redirects to where
/// `follow` allows (never from https to http); a redirect elsewhere comes
/// back as it is. Fails only without an answer.
pub async fn send(
    http: &reqwest::Client,
    seen: &Seen,
    outgoing: &Outgoing,
    authorization: Option<&str>,
    follow: &(dyn Fn(&Url) -> bool + Sync),
) -> Result<Answer, MailServerError> {
    let mut method = outgoing.method.clone();
    let mut url = outgoing.url.clone();
    let mut body = outgoing.body.clone();
    for _ in 0..=MAX_REDIRECTS {
        let mut request = http.request(method.clone(), url.clone());
        for (name, value) in &outgoing.headers {
            if ours(name) {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                request = request.header(name, value);
            }
        }
        if let Some(authorization) = authorization {
            request = request.header(AUTHORIZATION, authorization);
        }
        if !body.is_empty() {
            request = request.body(body.clone());
        }
        let response = request
            .send()
            .await
            .map_err(|error| transport_error(&error, seen))?;
        let status = response.status();
        let next = status
            .is_redirection()
            .then(|| response.headers().get(LOCATION))
            .flatten()
            .and_then(|location| location.to_str().ok())
            .and_then(|location| url.join(location).ok())
            .filter(|next| !(url.scheme() == "https" && next.scheme() != "https"))
            .filter(|next| follow(next));
        if let Some(next) = next {
            if status == reqwest::StatusCode::SEE_OTHER {
                method = Method::GET;
                body.clear();
            }
            url = next;
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|error| transport_error(&error, seen))?;
        return Ok(Answer {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_string(),
            headers,
            url,
            body: body.to_vec(),
        });
    }
    Err(MailServerError::server("The server redirected too often.").on(ServerRole::Caldav))
}

/// A request that got no answer: a refused certificate (with its
/// details), a failed TLS handshake, or no connection.
pub fn transport_error(error: &reqwest::Error, seen: &Seen) -> MailServerError {
    if let Some(refusal) = seen.refusal(ServerRole::Caldav) {
        return refusal;
    }
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        detail.push_str(": ");
        detail.push_str(&inner.to_string());
        source = inner.source();
    }
    let error = if error.is_timeout() {
        MailServerError::unreachable("The calendar server didn't answer in time.")
    } else if detail.contains("certificate")
        || detail.contains("tls")
        || detail.contains("TLS")
        || detail.contains("handshake")
    {
        MailServerError::tls(format!("TLS didn't work out: {detail}"))
    } else {
        MailServerError::unreachable(format!("No connection to the calendar server: {detail}"))
    };
    error.on(ServerRole::Caldav)
}

/// The login of a request, and renewing it once when it's a token.
pub struct Authorizer<'a> {
    source: Source<'a>,
    current: Option<(String, bool)>,
    renewed: bool,
}

enum Source<'a> {
    Fixed(String),
    Mail { imap: &'a Imap, key: &'a str },
}

impl<'a> Authorizer<'a> {
    /// For a server's login; the mail account's comes from `imap`.
    pub fn new(imap: &'a Imap, key: &'a str, login: &Login) -> Self {
        Self {
            source: match login {
                Login::SameAsMail => Source::Mail { imap, key },
                Login::Password { username, password } => {
                    Source::Fixed(basic_authorization(username, password))
                }
            },
            current: None,
            renewed: false,
        }
    }

    /// The `Authorization` value.
    pub async fn header(&mut self) -> Result<String, MailServerError> {
        if let Some((header, _)) = &self.current {
            return Ok(header.clone());
        }
        let current = match &self.source {
            Source::Fixed(header) => (header.clone(), false),
            Source::Mail { imap, key } => imap.http_authorization(key, false).await?,
        };
        self.current = Some(current.clone());
        Ok(current.0)
    }

    /// Renews a token that was refused, once; false if there's nothing to
    /// renew (a password: the refusal stands).
    pub async fn renew(&mut self) -> Result<bool, MailServerError> {
        let token = matches!(&self.current, Some((_, true)));
        let Source::Mail { imap, key } = &self.source else {
            return Ok(false);
        };
        if !token || self.renewed {
            return Ok(false);
        }
        self.renewed = true;
        self.current = Some(imap.http_authorization(key, true).await?);
        Ok(true)
    }
}

/// Where a user's calendars are.
#[derive(Debug, PartialEq)]
pub struct Found {
    pub principal: String,
    pub home: String,
    pub address: Option<String>,
    /// The origins the walk ended up on (where the login may go later).
    pub hosts: Vec<String>,
    pub scheduling: bool,
}

/// The addresses one candidate is tried at: a bare server also at its
/// `/.well-known/caldav` (first: that's where servers say where they are).
fn starts(candidate: &str) -> Vec<Url> {
    let Ok(url) = Url::parse(candidate.trim()) else {
        return Vec::new();
    };
    if !matches!(url.scheme(), "https" | "http") {
        return Vec::new();
    }
    if url.path() == "/" || url.path().is_empty() {
        let mut known = url.clone();
        known.set_path("/.well-known/caldav");
        known.set_query(None);
        return vec![known, url];
    }
    vec![url]
}

/// How telling an error is when no address worked: a certificate to decide
/// on first, then a refused login, then the rest.
fn rank(error: &MailServerError) -> u8 {
    match error.kind {
        ErrorKind::Untrusted => 0,
        ErrorKind::Auth => 1,
        ErrorKind::Tls => 2,
        ErrorKind::Unreachable => 3,
        _ => 4,
    }
}

/// Tries `candidates` in order with the login, until one leads to a
/// calendar home: PROPFIND `current-user-principal`, then the principal's
/// `calendar-home-set` and `calendar-user-address-set`, then OPTIONS on the
/// home for scheduling. Fails with the most telling error.
pub async fn find(
    http: &reqwest::Client,
    seen: &Seen,
    candidates: &[String],
    authorizer: &mut Authorizer<'_>,
) -> Result<Found, MailServerError> {
    let mut best: Option<MailServerError> = None;
    for start in candidates.iter().flat_map(|candidate| starts(candidate)) {
        match walk(http, seen, start, authorizer).await {
            Ok(found) => return Ok(found),
            Err(error) => {
                if best.as_ref().is_none_or(|best| rank(&error) < rank(best)) {
                    best = Some(error);
                }
            }
        }
    }
    Err(best
        .unwrap_or_else(|| {
            MailServerError::not_found("No calendar server answered at these addresses.")
        })
        .on(ServerRole::Caldav))
}

/// A PROPFIND (Depth 0) with the login, renewing a refused token once.
async fn propfind(
    http: &reqwest::Client,
    seen: &Seen,
    url: Url,
    props: &[(&str, &str)],
    authorizer: &mut Authorizer<'_>,
) -> Result<Answer, MailServerError> {
    let outgoing = Outgoing {
        method: Method::from_bytes(b"PROPFIND").expect("a method"),
        url,
        headers: vec![
            ("Depth".into(), "0".into()),
            (
                "Content-Type".into(),
                "application/xml; charset=utf-8".into(),
            ),
        ],
        body: dav::propfind(props).into_bytes(),
    };
    // Found addresses may lead anywhere (a domain's `.well-known` points to
    // its provider), but never from https to http.
    let anywhere = |_: &Url| true;
    let authorization = authorizer.header().await?;
    let answer = send(http, seen, &outgoing, Some(&authorization), &anywhere).await?;
    if answer.status == 401 && authorizer.renew().await? {
        let authorization = authorizer.header().await?;
        return send(http, seen, &outgoing, Some(&authorization), &anywhere).await;
    }
    Ok(answer)
}

/// Fails for answers that aren't a `multistatus`.
fn multistatus(answer: &Answer) -> Result<String, MailServerError> {
    match answer.status {
        207 => Ok(answer.text()),
        401 | 403 => Err(MailServerError::auth(
            "The calendar server refused the login.",
        )),
        status => Err(MailServerError::not_found(format!(
            "No calendar server at {} (HTTP {status}).",
            answer.url
        ))),
    }
}

async fn walk(
    http: &reqwest::Client,
    seen: &Seen,
    start: Url,
    authorizer: &mut Authorizer<'_>,
) -> Result<Found, MailServerError> {
    let answer = propfind(
        http,
        seen,
        start,
        &[(DAV, "current-user-principal")],
        authorizer,
    )
    .await?;
    let xml = multistatus(&answer)?;
    // No principal said: the address may be the principal itself.
    let principal = match dav::hrefs(&xml, DAV, "current-user-principal").first() {
        Some(href) => answer
            .url
            .join(href)
            .map_err(|_| MailServerError::server("The server named no usable principal."))?,
        None => answer.url.clone(),
    };

    let props = propfind(
        http,
        seen,
        principal.clone(),
        &[
            (CALDAV, "calendar-home-set"),
            (CALDAV, "calendar-user-address-set"),
            (DAV, "displayname"),
        ],
        authorizer,
    )
    .await?;
    let xml = multistatus(&props)?;
    let principal = props.url.clone();
    let home = dav::hrefs(&xml, CALDAV, "calendar-home-set")
        .first()
        .and_then(|href| principal.join(href).ok())
        .ok_or_else(|| MailServerError::not_found(format!("{} has no calendars.", answer.url)))?;
    let addresses = dav::hrefs(&xml, CALDAV, "calendar-user-address-set");
    let address = addresses
        .iter()
        .find_map(|href| {
            href.get(..7)
                .filter(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
                .map(|_| href[7..].trim().to_string())
        })
        .filter(|address| !address.is_empty());

    let options = Outgoing {
        method: Method::OPTIONS,
        url: home.clone(),
        headers: Vec::new(),
        body: Vec::new(),
    };
    let authorization = authorizer.header().await?;
    let scheduling = send(http, seen, &options, Some(&authorization), &|_| false)
        .await
        .ok()
        .and_then(|answer| answer.header("dav").map(str::to_ascii_lowercase))
        .is_some_and(|dav| {
            dav.split(',')
                .any(|item| item.trim() == "calendar-auto-schedule")
        });

    let mut hosts = Vec::new();
    for url in [&answer.url, &principal, &home] {
        if let Some(origin) = origin(url)
            && !hosts.contains(&origin)
        {
            hosts.push(origin);
        }
    }
    Ok(Found {
        principal: principal.to_string(),
        home: home.to_string(),
        address,
        hosts,
        scheduling,
    })
}
