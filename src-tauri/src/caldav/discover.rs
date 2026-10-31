//! Where an address's calendar server may be, the way Thunderbird and iOS
//! look (RFC 6764): a table of providers, the domain's DNS (`_caldavs._tcp`
//! SRV and its TXT `path`, desktop only: Android doesn't let apps read the
//! system's DNS settings), the domain's `/.well-known/caldav`, and the mail
//! server as a last guess. Nothing here signs in: connecting tries the
//! candidates in this order.

use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;

use crate::imap::MailServerError;
use crate::imap::discover::{address_domain, registrable};

/// How long the DNS lookups may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// Where a candidate comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateSource {
    Provider,
    Dns,
    WellKnown,
    MailHost,
}

/// A place a calendar server may be (`CalendarServerCandidate`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub url: String,
    pub source: CandidateSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_password_url: Option<String>,
}

/// A domain's CalDAV service from its DNS: `(host, port, path)`; `None`
/// if there's none or it can't be looked up here.
pub type SrvLookup =
    dyn Fn(String) -> BoxFuture<'static, Option<(String, u16, Option<String>)>> + Send + Sync;

/// The candidates for `address`, with the system's DNS.
pub async fn discover(
    address: &str,
    mail_host: Option<&str>,
) -> Result<Vec<Candidate>, MailServerError> {
    discover_with(address, mail_host, &system_srv).await
}

/// The candidates for `address`, with `srv` for the DNS step.
pub async fn discover_with(
    address: &str,
    mail_host: Option<&str>,
    srv: &SrvLookup,
) -> Result<Vec<Candidate>, MailServerError> {
    let domain = address_domain(address.trim())
        .ok_or_else(|| MailServerError::server("That isn't an email address."))?;
    let mut candidates = Vec::new();
    let mut add = |candidate: Candidate| {
        if !candidates
            .iter()
            .any(|known: &Candidate| known.url == candidate.url)
        {
            candidates.push(candidate);
        }
    };
    if let Some(known) = provider(&domain) {
        add(known);
    }
    if let Ok(Some((host, port, path))) =
        tokio::time::timeout(LOOKUP_TIMEOUT, srv(domain.clone())).await
    {
        let path = path
            .filter(|path| path.starts_with('/'))
            .unwrap_or_else(|| "/".into());
        let host = host.trim_end_matches('.');
        let url = if port == 443 {
            format!("https://{host}{path}")
        } else {
            format!("https://{host}:{port}{path}")
        };
        add(Candidate {
            url,
            source: CandidateSource::Dns,
            provider_name: None,
            app_password_url: None,
        });
    }
    add(Candidate {
        url: format!("https://{domain}/.well-known/caldav"),
        source: CandidateSource::WellKnown,
        provider_name: None,
        app_password_url: None,
    });
    if let Some(host) = mail_host
        .map(|host| host.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty() && host != &domain)
    {
        add(Candidate {
            url: format!("https://{host}/"),
            source: CandidateSource::MailHost,
            provider_name: None,
            app_password_url: None,
        });
    }
    Ok(candidates)
}

/// A provider action0 knows: its calendar server, and its contacts server
/// where that's a host of its own (otherwise the address books are found
/// on the calendar server's principal).
struct Known {
    name: &'static str,
    caldav: &'static str,
    carddav: Option<&'static str>,
    app_password: Option<&'static str>,
}

const ICLOUD: Known = Known {
    name: "iCloud",
    caldav: "https://caldav.icloud.com/",
    carddav: Some("https://contacts.icloud.com/"),
    app_password: Some("https://account.apple.com/account/manage"),
};
const FASTMAIL: Known = Known {
    name: "Fastmail",
    caldav: "https://caldav.fastmail.com/dav/",
    carddav: Some("https://carddav.fastmail.com/dav/"),
    app_password: Some("https://app.fastmail.com/settings/security/apps"),
};
const MAILBOX_ORG: Known = Known {
    name: "mailbox.org",
    caldav: "https://dav.mailbox.org/",
    carddav: None,
    app_password: None,
};
const GMX: Known = Known {
    name: "GMX",
    caldav: "https://caldav.gmx.net/",
    carddav: Some("https://carddav.gmx.net/"),
    app_password: None,
};
const WEB_DE: Known = Known {
    name: "WEB.DE",
    caldav: "https://caldav.web.de/",
    carddav: Some("https://carddav.web.de/"),
    app_password: None,
};
const POSTEO: Known = Known {
    name: "Posteo",
    caldav: "https://posteo.de:8443/",
    carddav: None,
    app_password: None,
};
const YAHOO: Known = Known {
    name: "Yahoo",
    caldav: "https://caldav.calendar.yahoo.com/",
    carddav: Some("https://carddav.address.yahoo.com/"),
    app_password: Some("https://login.yahoo.com/account/security/app-passwords"),
};
const ZOHO: Known = Known {
    name: "Zoho",
    caldav: "https://calendar.zoho.com/caldav/",
    carddav: None,
    app_password: None,
};

/// Every provider of the table, to find one by its calendar server.
const ALL: [&Known; 8] = [
    &ICLOUD,
    &FASTMAIL,
    &MAILBOX_ORG,
    &GMX,
    &WEB_DE,
    &POSTEO,
    &YAHOO,
    &ZOHO,
];

/// The provider of an address's domain, if action0 knows it.
fn known(domain: &str) -> Option<&'static Known> {
    let registrable = registrable(domain);
    let brand = registrable.split('.').next().unwrap_or_default();
    Some(match (brand, registrable.as_str()) {
        (_, "icloud.com" | "me.com" | "mac.com") => &ICLOUD,
        ("fastmail" | "messagingengine", _) => &FASTMAIL,
        (_, "mailbox.org") => &MAILBOX_ORG,
        ("gmx", _) => &GMX,
        (_, "web.de") => &WEB_DE,
        ("posteo", _) => &POSTEO,
        ("yahoo" | "ymail" | "rocketmail", _) => &YAHOO,
        ("zoho" | "zohomail", _) => &ZOHO,
        _ => return None,
    })
}

/// Providers whose calendar servers action0 knows, by the address's domain.
fn provider(domain: &str) -> Option<Candidate> {
    known(domain).map(|known| Candidate {
        url: known.caldav.into(),
        source: CandidateSource::Provider,
        provider_name: Some(known.name.into()),
        app_password_url: known.app_password.map(str::to_string),
    })
}

/// The contacts server of the provider of an address's domain, where it's a
/// host of its own.
pub fn contacts_for_domain(domain: &str) -> Option<&'static str> {
    known(&domain.trim().to_ascii_lowercase()).and_then(|known| known.carddav)
}

/// The contacts server of the provider whose calendar server is `host`
/// (calendar-only servers, which have no address), where it's a host of
/// its own.
pub fn contacts_for_calendar_host(host: &str) -> Option<&'static str> {
    ALL.iter()
        .find(|known| {
            url::Url::parse(known.caldav)
                .ok()
                .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
                .is_some_and(|known_host| known_host.eq_ignore_ascii_case(host))
        })
        .and_then(|known| known.carddav)
}

/// The domain's `_caldavs._tcp` service and its TXT `path`, from the
/// system's DNS settings.
#[cfg(desktop)]
fn system_srv(domain: String) -> BoxFuture<'static, Option<(String, u16, Option<String>)>> {
    Box::pin(async move {
        use hickory_resolver::TokioResolver;
        use hickory_resolver::proto::rr::RData;
        let resolver = TokioResolver::builder_tokio().ok()?.build().ok()?;
        let name = format!("_caldavs._tcp.{domain}.");
        let lookup = resolver.srv_lookup(name.clone()).await.ok()?;
        let mut records: Vec<(u16, u16, String, u16)> = lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::SRV(srv) => Some((
                    srv.priority,
                    u16::MAX - srv.weight,
                    srv.target.to_ascii(),
                    srv.port,
                )),
                _ => None,
            })
            .collect();
        records.sort();
        let (_, _, host, port) = records.into_iter().next()?;
        // "." means the service isn't offered (RFC 2782).
        if host.trim_end_matches('.').is_empty() {
            return None;
        }
        let path = resolver.txt_lookup(name).await.ok().and_then(|lookup| {
            lookup
                .answers()
                .iter()
                .find_map(|record| match &record.data {
                    RData::TXT(txt) => txt.txt_data.iter().find_map(|data| {
                        std::str::from_utf8(data)
                            .ok()?
                            .strip_prefix("path=")
                            .map(str::to_string)
                    }),
                    _ => None,
                })
        });
        Some((host, port, path))
    })
}

#[cfg(not(desktop))]
fn system_srv(_domain: String) -> BoxFuture<'static, Option<(String, u16, Option<String>)>> {
    Box::pin(async { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_srv(_: String) -> BoxFuture<'static, Option<(String, u16, Option<String>)>> {
        Box::pin(async { None })
    }

    fn urls(candidates: &[Candidate]) -> Vec<(&str, CandidateSource)> {
        candidates
            .iter()
            .map(|candidate| (candidate.url.as_str(), candidate.source))
            .collect()
    }

    #[tokio::test]
    async fn knows_providers_then_tries_the_domain_and_the_mail_server() {
        let found = discover_with("Me@Me.com", Some("imap.mail.me.com"), &no_srv)
            .await
            .unwrap();
        assert_eq!(
            urls(&found),
            [
                ("https://caldav.icloud.com/", CandidateSource::Provider),
                (
                    "https://me.com/.well-known/caldav",
                    CandidateSource::WellKnown
                ),
                ("https://imap.mail.me.com/", CandidateSource::MailHost),
            ]
        );
        assert_eq!(found[0].provider_name.as_deref(), Some("iCloud"));
        assert!(found[0].app_password_url.is_some());

        for (address, url) in [
            ("a@fastmail.fm", "https://caldav.fastmail.com/dav/"),
            ("a@gmx.at", "https://caldav.gmx.net/"),
            ("a@web.de", "https://caldav.web.de/"),
            ("a@posteo.net", "https://posteo.de:8443/"),
            ("a@mailbox.org", "https://dav.mailbox.org/"),
            ("a@yahoo.co.uk", "https://caldav.calendar.yahoo.com/"),
            ("a@zohomail.eu", "https://calendar.zoho.com/caldav/"),
        ] {
            let found = discover_with(address, None, &no_srv).await.unwrap();
            assert_eq!(found[0].url, url, "{address}");
        }
    }

    #[test]
    fn knows_providers_with_contacts_on_a_host_of_their_own() {
        assert_eq!(
            contacts_for_domain("fastmail.fm"),
            Some("https://carddav.fastmail.com/dav/")
        );
        assert_eq!(
            contacts_for_domain("me.com"),
            Some("https://contacts.icloud.com/")
        );
        assert_eq!(
            contacts_for_domain("gmx.at"),
            Some("https://carddav.gmx.net/")
        );
        // Same server as the calendars, or not a known provider.
        assert_eq!(contacts_for_domain("mailbox.org"), None);
        assert_eq!(contacts_for_domain("example.org"), None);
        assert_eq!(
            contacts_for_calendar_host("caldav.fastmail.com"),
            Some("https://carddav.fastmail.com/dav/")
        );
        assert_eq!(contacts_for_calendar_host("posteo.de"), None);
        assert_eq!(contacts_for_calendar_host("cloud.example.org"), None);
    }

    #[tokio::test]
    async fn asks_dns_for_other_domains() {
        let srv = |domain: String| -> BoxFuture<'static, Option<(String, u16, Option<String>)>> {
            Box::pin(async move {
                (domain == "example.org")
                    .then(|| ("dav.example.org.".to_string(), 8443, Some("/cal/".into())))
            })
        };
        let found = discover_with("me@example.org", Some("mail.example.org"), &srv)
            .await
            .unwrap();
        assert_eq!(
            urls(&found),
            [
                ("https://dav.example.org:8443/cal/", CandidateSource::Dns),
                (
                    "https://example.org/.well-known/caldav",
                    CandidateSource::WellKnown
                ),
                ("https://mail.example.org/", CandidateSource::MailHost),
            ]
        );
        // The mail server isn't tried twice when it's the domain itself.
        let found = discover_with("me@example.net", Some("example.net"), &no_srv)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert!(
            discover_with("not an address", None, &no_srv)
                .await
                .is_err()
        );
    }
}
