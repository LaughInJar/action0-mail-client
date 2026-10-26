//! Finding an address's server settings, the way Thunderbird does: the
//! provider's own configuration (`autoconfig.<domain>`, then its
//! `.well-known` address), Mozilla's provider database (ISPDB, which only
//! learns the domain), then the domain's mail servers (MX) and what's known
//! about their provider. They're asked at the same time; the first of
//! those that knows the settings wins. Gmail and Microsoft addresses are
//! pointed to their own account types; a small table adds app-password and
//! "switch IMAP on" pages, and Yahoo/AOL's sign-in.

use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;

use super::account::{MailServer, MailServerSettings, OAuthProvider, Security};
use super::error::MailServerError;

/// How long each lookup may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// The most a configuration file may have.
const CONFIG_LIMIT: usize = 512 * 1024;

/// Where the settings came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Provider,
    Ispdb,
    Mx,
    None,
}

/// An account type that suits the address better.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    Gmail,
    Microsoft,
}

/// What was found out about an address (`MailServerDiscovery`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<MailServerSettings>,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_password_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_imap_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub better: Option<Better>,
}

impl Discovery {
    fn nothing() -> Self {
        Self {
            settings: None,
            source: Source::None,
            provider_name: None,
            app_password_url: None,
            enable_imap_url: None,
            oauth: None,
            better: None,
        }
    }
}

/// Where the configuration files are looked for (tests: a local server).
/// `{domain}` in an address is the domain asked about.
pub struct Places {
    /// A domain's own configuration addresses, in order of preference.
    pub provider: Vec<String>,
    /// The ISPDB's address.
    pub ispdb: String,
    /// Only take answers that came over https (also after redirects).
    pub https_only: bool,
}

impl Places {
    /// The real places.
    pub fn real() -> Self {
        Self {
            provider: vec![
                "https://autoconfig.{domain}/mail/config-v1.1.xml".into(),
                "https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml".into(),
            ],
            ispdb: "https://autoconfig.thunderbird.net/v1.1/{domain}".into(),
            https_only: true,
        }
    }

    fn provider(&self, domain: &str) -> Vec<String> {
        self.provider
            .iter()
            .map(|url| url.replace("{domain}", domain))
            .collect()
    }

    fn ispdb(&self, domain: &str) -> String {
        self.ispdb.replace("{domain}", domain)
    }
}

/// A domain's mail servers (MX), best first; `None` if they can't be
/// looked up here.
pub type MxLookup = dyn Fn(String) -> BoxFuture<'static, Option<Vec<String>>> + Send + Sync;

/// Looks up `address`'s settings in the real places.
pub async fn discover(http: &reqwest::Client, address: &str) -> Result<Discovery, MailServerError> {
    discover_with(http, &Places::real(), &system_mx, address).await
}

/// Looks up `address`'s settings in `places`, with `mx` for the MX step.
pub async fn discover_with(
    http: &reqwest::Client,
    places: &Places,
    mx: &MxLookup,
    address: &str,
) -> Result<Discovery, MailServerError> {
    let address = address.trim();
    let domain = address_domain(address)
        .ok_or_else(|| MailServerError::server("That isn't an email address."))?;

    if matches!(domain.as_str(), "gmail.com" | "googlemail.com") {
        return Ok(gmail(address, Source::Provider));
    }
    if is_microsoft(&domain) {
        return Ok(Discovery {
            provider_name: Some("Outlook.com".into()),
            better: Some(Better::Microsoft),
            ..Discovery::nothing()
        });
    }

    let ispdb = places.ispdb(&domain);
    let (own, ispdb, by_mx) = tokio::join!(
        own_config(http, places, &domain, address, true),
        fetch_config(http, places, &ispdb, address),
        mx_config(http, places, mx, &domain, address),
    );
    let (found, source, better) = match (own, ispdb, by_mx) {
        (Some(found), _, mx) => (Some(found), Source::Provider, mx.better),
        (None, Some(found), mx) => (Some(found), Source::Ispdb, mx.better),
        (None, None, mx) if mx.better == Some(Better::Gmail) => {
            return Ok(gmail(address, Source::Mx));
        }
        (None, None, mx) => {
            let source = if mx.found.is_some() {
                Source::Mx
            } else {
                Source::None
            };
            (mx.found, source, mx.better)
        }
    };

    let mut discovery = Discovery {
        source,
        better,
        ..Discovery::nothing()
    };
    if let Some((settings, name)) = found {
        discovery.provider_name = name;
        discovery.settings = Some(settings);
    }
    let hint = hint(&domain).or_else(|| {
        discovery
            .settings
            .as_ref()
            .and_then(|settings| hint(&settings.imap.host))
    });
    if let Some(hint) = hint {
        discovery.app_password_url = hint.app_password_url.map(str::to_string);
        discovery.enable_imap_url = hint.enable_imap_url.map(str::to_string);
        discovery.oauth = hint.oauth;
    }
    Ok(discovery)
}

/// The settings, and the provider's name.
type Found = (MailServerSettings, Option<String>);

/// The domain's own configuration (the first address that has one). The
/// address goes along (`send_address`) only to the address's own domain.
async fn own_config(
    http: &reqwest::Client,
    places: &Places,
    domain: &str,
    address: &str,
    send_address: bool,
) -> Option<Found> {
    let urls = places.provider(domain);
    let lookups = urls.iter().enumerate().map(|(i, url)| {
        let url = if i == 0 && send_address {
            with_address(url, address)
        } else {
            url.clone()
        };
        async move { fetch_config(http, places, &url, address).await }
    });
    futures::future::join_all(lookups)
        .await
        .into_iter()
        .flatten()
        .next()
}

fn with_address(url: &str, address: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut url) => {
            url.query_pairs_mut().append_pair("emailaddress", address);
            url.into()
        }
        Err(_) => url.to_string(),
    }
}

/// What the MX step found: settings, or a better account type.
#[derive(Default)]
struct ByMx {
    found: Option<Found>,
    better: Option<Better>,
}

/// The MX step: who runs the domain's mail servers, and what's known
/// about them (ISPDB, then their own configuration).
async fn mx_config(
    http: &reqwest::Client,
    places: &Places,
    mx: &MxLookup,
    domain: &str,
    address: &str,
) -> ByMx {
    let Some(hosts) = tokio::time::timeout(LOOKUP_TIMEOUT, mx(domain.to_string()))
        .await
        .ok()
        .flatten()
    else {
        return ByMx::default();
    };
    let Some(host) = hosts.first() else {
        return ByMx::default();
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "google.com"
        || host == "googlemail.com"
        || host.ends_with(".google.com")
        || host.ends_with(".googlemail.com")
    {
        return ByMx {
            found: None,
            better: Some(Better::Gmail),
        };
    }
    if host.ends_with(".mail.protection.outlook.com") {
        return ByMx {
            found: None,
            better: Some(Better::Microsoft),
        };
    }
    let mx_domain = registrable(&host);
    if mx_domain == domain {
        return ByMx::default();
    }
    let found = match fetch_config(http, places, &places.ispdb(&mx_domain), address).await {
        Some(found) => Some(found),
        None => own_config(http, places, &mx_domain, address, false).await,
    };
    ByMx {
        found,
        better: None,
    }
}

/// Fetches and reads one configuration file.
async fn fetch_config(
    http: &reqwest::Client,
    places: &Places,
    url: &str,
    address: &str,
) -> Option<Found> {
    let mut response = http.get(url).timeout(LOOKUP_TIMEOUT).send().await.ok()?;
    if !response.status().is_success() || (places.https_only && response.url().scheme() != "https")
    {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > CONFIG_LIMIT {
            return None;
        }
    }
    parse_config(&String::from_utf8_lossy(&body), address)
}

/// Reads a Thunderbird configuration file (`clientConfig/emailProvider`):
/// its first IMAP and SMTP servers with TLS or STARTTLS (never plain),
/// those with a password login preferred, placeholders filled in.
pub fn parse_config(xml: &str, address: &str) -> Option<Found> {
    let document = roxmltree::Document::parse(xml).ok()?;
    let provider = document
        .descendants()
        .find(|node| node.has_tag_name("emailProvider"))?;
    let name = child_text(provider, "displayName").filter(|name| !name.is_empty());
    let (imap, imap_user) = pick_server(provider, "incomingServer", "imap", address)?;
    let (smtp, _) = pick_server(provider, "outgoingServer", "smtp", address)?;
    Some((
        MailServerSettings {
            imap,
            smtp,
            username: imap_user.unwrap_or_else(|| address.to_string()),
        },
        name,
    ))
}

fn child_text(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.has_tag_name(name))
        .and_then(|child| child.text())
        .map(|text| text.trim().to_string())
}

/// The server of `kind` to use, and its user name.
fn pick_server(
    provider: roxmltree::Node<'_, '_>,
    tag: &str,
    kind: &str,
    address: &str,
) -> Option<(MailServer, Option<String>)> {
    let candidates: Vec<(MailServer, Option<String>, bool)> = provider
        .children()
        .filter(|node| node.has_tag_name(tag) && node.attribute("type") == Some(kind))
        .filter_map(|node| {
            let security = match child_text(node, "socketType")?
                .to_ascii_uppercase()
                .as_str()
            {
                "SSL" | "TLS" => Security::Tls,
                "STARTTLS" => Security::Starttls,
                _ => return None,
            };
            let host = fill(&child_text(node, "hostname")?, address);
            let port = child_text(node, "port")?
                .parse::<u16>()
                .ok()
                .filter(|&p| p > 0)?;
            if host.is_empty() || host.contains('%') {
                return None;
            }
            let user = child_text(node, "username")
                .map(|user| fill(&user, address))
                .filter(|user| !user.is_empty());
            let password = node
                .children()
                .filter(|child| child.has_tag_name("authentication"))
                .any(|child| {
                    matches!(
                        child.text().map(str::trim),
                        Some("password-cleartext" | "password-encrypted")
                    )
                });
            Some((
                MailServer {
                    host,
                    port,
                    security,
                },
                user,
                password,
            ))
        })
        .collect();
    let best = candidates
        .iter()
        .position(|(_, _, password)| *password)
        .unwrap_or(0);
    candidates
        .into_iter()
        .nth(best)
        .map(|(server, user, _)| (server, user))
}

/// Fills in a configuration's placeholders.
fn fill(text: &str, address: &str) -> String {
    let (local, domain) = address.rsplit_once('@').unwrap_or((address, ""));
    text.replace("%EMAILADDRESS%", address)
        .replace("%EMAILLOCALPART%", local)
        .replace("%EMAILDOMAIN%", domain)
}

/// The domain of an address, as a lower-case ASCII host name (IDNs in
/// punycode); `None` if it isn't one.
pub fn address_domain(address: &str) -> Option<String> {
    let (local, domain) = address.rsplit_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    let url = url::Url::parse(&format!("https://{domain}/")).ok()?;
    match url.host()? {
        url::Host::Domain(host) if host.contains('.') => {
            Some(host.trim_end_matches('.').to_ascii_lowercase())
        }
        _ => None,
    }
}

/// The part of a host name its owner registered (`mx01.emig.gmx.net` →
/// `gmx.net`, `mx.yahoo.co.jp` → `yahoo.co.jp`). A guess without the public
/// suffix list: two labels, three under country domains like `co.uk`.
pub fn registrable(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    if n <= 2 {
        return host;
    }
    let second_level = matches!(
        labels[n - 2],
        "co" | "com" | "net" | "org" | "ac" | "gov" | "edu" | "or" | "ne" | "go" | "gv"
    );
    let take = if labels[n - 1].len() == 2 && second_level {
        3
    } else {
        2
    };
    labels[n - take..].join(".")
}

/// Outlook.com's own domains (Microsoft 365 is found by its MX).
fn is_microsoft(domain: &str) -> bool {
    let registrable = registrable(domain);
    let brand = registrable.split('.').next().unwrap_or_default();
    matches!(brand, "outlook" | "hotmail" | "live") || registrable == "msn.com"
}

/// Gmail's IMAP settings, for addresses better added as Gmail accounts.
fn gmail(address: &str, source: Source) -> Discovery {
    Discovery {
        settings: Some(MailServerSettings {
            imap: MailServer {
                host: "imap.gmail.com".into(),
                port: 993,
                security: Security::Tls,
            },
            smtp: MailServer {
                host: "smtp.gmail.com".into(),
                port: 465,
                security: Security::Tls,
            },
            username: address.to_string(),
        }),
        source,
        provider_name: Some("Gmail".into()),
        app_password_url: Some("https://myaccount.google.com/apppasswords".into()),
        better: Some(Better::Gmail),
        ..Discovery::nothing()
    }
}

/// What's known about a provider beyond its settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Hint {
    app_password_url: Option<&'static str>,
    enable_imap_url: Option<&'static str>,
    oauth: Option<OAuthProvider>,
}

/// The hints for a domain or server host name, if it's a known provider's.
fn hint(host: &str) -> Option<Hint> {
    let registrable = registrable(host);
    let brand = registrable.split('.').next().unwrap_or_default();
    let app_password = |url| Hint {
        app_password_url: Some(url),
        enable_imap_url: None,
        oauth: None,
    };
    let enable_imap = |url| Hint {
        app_password_url: None,
        enable_imap_url: Some(url),
        oauth: None,
    };
    Some(match (brand, registrable.as_str()) {
        ("yahoo" | "ymail" | "rocketmail", _) => Hint {
            oauth: Some(OAuthProvider::Yahoo),
            ..app_password("https://login.yahoo.com/account/security/app-passwords")
        },
        ("aol", _) | (_, "aim.com") => Hint {
            oauth: Some(OAuthProvider::Aol),
            ..app_password("https://login.aol.com/account/security/app-passwords")
        },
        (_, "icloud.com" | "me.com" | "mac.com") => {
            app_password("https://account.apple.com/account/manage")
        }
        ("fastmail" | "messagingengine", _) => {
            app_password("https://app.fastmail.com/settings/security/apps")
        }
        ("gmx", _) => enable_imap("https://support.gmx.com/pop-imap/toggle.html"),
        (_, "web.de") => enable_imap("https://hilfe.web.de/pop-imap/einschalten.html"),
        _ => return None,
    })
}

/// The domain's MX hosts from the system's DNS settings. Android doesn't
/// let apps read those, so there's no MX step there.
#[cfg(desktop)]
fn system_mx(domain: String) -> BoxFuture<'static, Option<Vec<String>>> {
    Box::pin(async move {
        use hickory_resolver::TokioResolver;
        use hickory_resolver::proto::rr::RData;
        let resolver = TokioResolver::builder_tokio().ok()?.build().ok()?;
        let lookup = resolver.mx_lookup(format!("{domain}.")).await.ok()?;
        let mut records: Vec<(u16, String)> = lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::MX(mx) => Some((mx.preference, mx.exchange.to_ascii())),
                _ => None,
            })
            .collect();
        records.sort();
        Some(records.into_iter().map(|(_, host)| host).collect())
    })
}

#[cfg(not(desktop))]
fn system_mx(_domain: String) -> BoxFuture<'static, Option<Vec<String>>> {
    Box::pin(async { None })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    const GMX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="gmx.net">
    <domain>gmx.net</domain>
    <displayName>GMX Freemail</displayName>
    <incomingServer type="pop3">
      <hostname>pop.gmx.net</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.gmx.net</hostname>
      <port>143</port>
      <socketType>plain</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.gmx.net</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>mail.gmx.net</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>"#;

    fn config(imap_host: &str, user: &str) -> String {
        format!(
            r#"<clientConfig version="1.1"><emailProvider id="x">
              <displayName>Example Mail</displayName>
              <incomingServer type="imap">
                <hostname>{imap_host}</hostname><port>993</port><socketType>SSL</socketType>
                <username>{user}</username><authentication>OAuth2</authentication>
              </incomingServer>
              <incomingServer type="imap">
                <hostname>imap2.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType>
                <username>{user}</username>
                <authentication>OAuth2</authentication>
                <authentication>password-encrypted</authentication>
              </incomingServer>
              <outgoingServer type="smtp">
                <hostname>smtp.example.org</hostname><port>465</port><socketType>SSL</socketType>
              </outgoingServer>
            </emailProvider></clientConfig>"#
        )
    }

    #[test]
    fn reads_a_configuration_file() {
        let (settings, name) = parse_config(GMX, "max@gmx.at").unwrap();
        assert_eq!(name.as_deref(), Some("GMX Freemail"));
        assert_eq!(
            settings.imap,
            MailServer {
                host: "imap.gmx.net".into(),
                port: 993,
                security: Security::Tls
            }
        );
        assert_eq!(settings.smtp.security, Security::Starttls);
        assert_eq!(settings.smtp.port, 587);
        assert_eq!(settings.username, "max@gmx.at");
    }

    #[test]
    fn prefers_password_logins_and_fills_in_placeholders() {
        let (settings, _) = parse_config(
            &config("imap.example.org", "%EMAILLOCALPART%"),
            "max@example.org",
        )
        .unwrap();
        assert_eq!(settings.imap.host, "imap2.example.org");
        assert_eq!(settings.imap.security, Security::Starttls);
        assert_eq!(settings.username, "max");
        // No user name in the SMTP entry: the address.
        assert_eq!(settings.smtp.host, "smtp.example.org");
        assert!(parse_config("<html>not found</html>", "a@b.c").is_none());
        assert!(parse_config("<clientConfig/>", "a@b.c").is_none());
    }

    #[test]
    fn finds_the_registered_domain() {
        assert_eq!(registrable("mx01.emig.gmx.net"), "gmx.net");
        assert_eq!(registrable("mx.yahoo.co.jp."), "yahoo.co.jp");
        assert_eq!(registrable("mail.example.co.uk"), "example.co.uk");
        assert_eq!(registrable("example.org"), "example.org");
        assert_eq!(registrable("imap.mail.me.com"), "me.com");
        assert_eq!(
            address_domain("Max@Bücher.Example"),
            Some("xn--bcher-kva.example".into())
        );
        assert_eq!(address_domain("max@localhost"), None);
        assert_eq!(address_domain("max@[127.0.0.1]"), None);
        assert_eq!(address_domain("@example.org"), None);
    }

    #[test]
    fn knows_some_providers() {
        let yahoo = hint("yahoo.co.uk").unwrap();
        assert_eq!(yahoo.oauth, Some(OAuthProvider::Yahoo));
        assert!(yahoo.app_password_url.unwrap().contains("login.yahoo.com"));
        assert_eq!(hint("aim.com").unwrap().oauth, Some(OAuthProvider::Aol));
        assert!(
            hint("imap.mail.me.com")
                .unwrap()
                .app_password_url
                .unwrap()
                .contains("apple")
        );
        assert!(
            hint("gmx.de")
                .unwrap()
                .enable_imap_url
                .unwrap()
                .contains("gmx.com")
        );
        assert!(
            hint("web.de")
                .unwrap()
                .enable_imap_url
                .unwrap()
                .contains("web.de")
        );
        assert!(hint("fastmail.fm").is_some());
        assert_eq!(hint("example.org"), None);
        assert!(
            is_microsoft("hotmail.de") && is_microsoft("msn.com") && is_microsoft("outlook.com")
        );
        assert!(!is_microsoft("example.org"));
    }

    #[test]
    fn looks_only_at_https_addresses() {
        let places = Places::real();
        assert_eq!(
            places.provider("gmx.at"),
            [
                "https://autoconfig.gmx.at/mail/config-v1.1.xml",
                "https://gmx.at/.well-known/autoconfig/mail/config-v1.1.xml"
            ]
        );
        assert_eq!(
            places.ispdb("gmx.at"),
            "https://autoconfig.thunderbird.net/v1.1/gmx.at"
        );
        assert!(places.https_only);
        assert_eq!(
            with_address(
                "https://autoconfig.gmx.at/mail/config-v1.1.xml",
                "max+x@gmx.at"
            ),
            "https://autoconfig.gmx.at/mail/config-v1.1.xml?emailaddress=max%2Bx%40gmx.at"
        );
    }

    fn places(server: &MockServer) -> Places {
        let base = server.uri();
        Places {
            provider: vec![
                format!("{base}/autoconfig/{{domain}}"),
                format!("{base}/well-known/{{domain}}"),
            ],
            ispdb: format!("{base}/ispdb/{{domain}}"),
            https_only: false,
        }
    }

    /// An MX lookup that answers `hosts`.
    fn mx(hosts: &'static [&'static str]) -> Arc<MxLookup> {
        Arc::new(move |_domain| {
            Box::pin(async move { Some(hosts.iter().map(|h| h.to_string()).collect()) })
        })
    }

    fn http() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::net::http_client()
    }

    fn xml(body: &str) -> ResponseTemplate {
        ResponseTemplate::new(200)
            .insert_header("content-type", "text/xml")
            .set_body_string(body)
    }

    #[tokio::test]
    async fn the_providers_own_configuration_comes_first() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/autoconfig/example.org"))
            .and(query_param("emailaddress", "max@example.org"))
            .respond_with(xml(&config("imap.example.org", "%EMAILADDRESS%")))
            .mount(&server)
            .await;
        Mock::given(path("/ispdb/example.org"))
            .respond_with(xml(GMX))
            .mount(&server)
            .await;
        let http = http();
        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@example.org")
            .await
            .unwrap();
        assert_eq!(found.source, Source::Provider);
        assert_eq!(found.provider_name.as_deref(), Some("Example Mail"));
        assert_eq!(found.settings.unwrap().imap.host, "imap2.example.org");
    }

    #[tokio::test]
    async fn then_the_well_known_address_then_the_ispdb() {
        let server = MockServer::start().await;
        Mock::given(path("/well-known/example.org"))
            .respond_with(xml(&config("imap.example.org", "%EMAILADDRESS%")))
            .mount(&server)
            .await;
        Mock::given(path("/ispdb/example.org"))
            .respond_with(xml(GMX))
            .mount(&server)
            .await;
        let http = http();
        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@example.org")
            .await
            .unwrap();
        assert_eq!(found.source, Source::Provider);

        let server = MockServer::start().await;
        Mock::given(path("/ispdb/gmx.at"))
            .respond_with(xml(GMX))
            .mount(&server)
            .await;
        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@gmx.at")
            .await
            .unwrap();
        assert_eq!(found.source, Source::Ispdb);
        assert_eq!(found.provider_name.as_deref(), Some("GMX Freemail"));
        assert!(found.enable_imap_url.is_some());
        assert_eq!(found.oauth, None);
    }

    #[tokio::test]
    async fn then_who_runs_the_mail_servers() {
        let server = MockServer::start().await;
        Mock::given(path("/ispdb/gmx.net"))
            .respond_with(xml(GMX))
            .mount(&server)
            .await;
        let http = http();
        let found = discover_with(
            &http,
            &places(&server),
            &*mx(&["mx01.emig.gmx.net.", "mx00.emig.gmx.net."]),
            "max@my-own-domain.at",
        )
        .await
        .unwrap();
        assert_eq!(found.source, Source::Mx);
        let settings = found.settings.unwrap();
        assert_eq!(settings.imap.host, "imap.gmx.net");
        assert_eq!(settings.username, "max@my-own-domain.at");
        // The hint comes from the server's domain.
        assert!(found.enable_imap_url.is_some());
    }

    #[tokio::test]
    async fn sends_gmail_and_microsoft_to_their_own_account_types() {
        let server = MockServer::start().await;
        let http = http();
        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@gmail.com")
            .await
            .unwrap();
        assert_eq!(found.better, Some(Better::Gmail));
        assert_eq!(found.settings.unwrap().imap.host, "imap.gmail.com");
        assert!(found.app_password_url.is_some());

        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@hotmail.com")
            .await
            .unwrap();
        assert_eq!(found.better, Some(Better::Microsoft));
        assert_eq!(found.settings, None);
        assert_eq!(found.source, Source::None);
        // Neither asked anyone.
        assert!(server.received_requests().await.unwrap().is_empty());

        let found = discover_with(
            &http,
            &places(&server),
            &*mx(&["aspmx.l.google.com."]),
            "max@company.example",
        )
        .await
        .unwrap();
        assert_eq!(found.better, Some(Better::Gmail));
        assert_eq!(found.source, Source::Mx);
        assert_eq!(found.settings.unwrap().username, "max@company.example");

        let found = discover_with(
            &http,
            &places(&server),
            &*mx(&["company-example.mail.protection.outlook.com."]),
            "max@company.example",
        )
        .await
        .unwrap();
        assert_eq!(found.better, Some(Better::Microsoft));
        assert_eq!(found.settings, None);
    }

    #[tokio::test]
    async fn knows_yahoos_sign_in_and_says_when_it_found_nothing() {
        let server = MockServer::start().await;
        let http = http();
        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@yahoo.de")
            .await
            .unwrap();
        assert_eq!(found.oauth, Some(OAuthProvider::Yahoo));
        assert!(found.app_password_url.is_some());
        assert_eq!(found.source, Source::None);

        let found = discover_with(&http, &places(&server), &*mx(&[]), "max@nowhere.example")
            .await
            .unwrap();
        assert_eq!(found, Discovery::nothing());
        assert_eq!(
            serde_json::to_value(&found).unwrap(),
            serde_json::json!({"source": "none"})
        );
        assert!(
            discover_with(&http, &places(&server), &*mx(&[]), "no address")
                .await
                .is_err()
        );
    }

    #[test]
    fn reaches_the_ui_in_its_shape() {
        let json = serde_json::to_value(gmail("max@gmail.com", Source::Provider)).unwrap();
        assert_eq!(json["source"], "provider");
        assert_eq!(json["better"], "gmail");
        assert_eq!(json["providerName"], "Gmail");
        assert_eq!(
            json["appPasswordUrl"],
            "https://myaccount.google.com/apppasswords"
        );
        assert_eq!(json["settings"]["imap"]["security"], "tls");
        assert!(json.get("oauth").is_none());
    }
}
