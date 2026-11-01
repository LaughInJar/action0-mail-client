//! Send later while the Android app isn't open (its background check):
//! drafts marked with a time (`X-Action0-Send-At`, see
//! `src/core/schedule.ts`) go out once they're due, as the app sends them:
//! without the marker, dated now. Mail more than 30 minutes late waits for
//! the app, which asks first. Work and school Outlook accounts need none of
//! this: Exchange holds their mail itself.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::Deserialize;

/// The header that marks a scheduled draft.
pub const SEND_AT_HEADER: &str = "X-Action0-Send-At";
/// A mail this late isn't sent unasked.
const MISSED_AFTER_MS: u64 = 30 * 60 * 1000;
/// Another action0 than the one that scheduled a mail waits this long.
pub const OTHERS_WAIT_MS: u64 = 2 * 60 * 1000;
/// Where personal Outlook accounts keep the time (see `GraphProvider.ts`).
const GRAPH_PROPERTY: &str = "String {8a3b7c2e-5d41-4f0a-9b6e-a0c1d2e3f405} Name action0SendAt";
/// Drafts looked at per account and check.
const MAX_DRAFTS: usize = 100;

/// Gmail's base64url, with or without padding.
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// A scheduled draft's marker: when it goes out, and which action0 scheduled it.
#[derive(Debug, PartialEq, Eq)]
pub struct Marker {
    /// Epoch ms.
    pub at: u64,
    pub by: Option<String>,
}

impl Marker {
    /// `2026-11-03T07:00:00.000Z; by=abc`; `None` if it isn't one.
    pub fn parse(value: &str) -> Option<Self> {
        let mut parts = value.split(';').map(str::trim);
        let at = parse_iso_utc(parts.next()?)?;
        let by = parts
            .find_map(|part| part.strip_prefix("by="))
            .map(|by| by.trim().to_string())
            .filter(|by| !by.is_empty());
        Some(Self { at, by })
    }

    /// Due now for this action0 (`device`), and not too late to send unasked.
    pub fn is_due(&self, now: u64, device: &str) -> bool {
        let wait = if self.by.as_deref().is_none_or(|by| by == device) {
            0
        } else {
            OTHERS_WAIT_MS
        };
        now >= self.at + wait && now - self.at <= MISSED_AFTER_MS
    }
}

/// `raw` with the headers named in `drop` left out (folded lines too), and
/// `Date` set to `date` if given. Only the header block changes.
pub fn rewrite_headers(raw: &[u8], drop: &[&str], date: Option<&str>) -> Vec<u8> {
    let (end, separator) = match find(raw, b"\r\n\r\n") {
        Some(at) => (at, 4),
        None => match find(raw, b"\n\n") {
            Some(at) => (at, 2),
            None => (raw.len(), 0),
        },
    };
    let header = String::from_utf8_lossy(&raw[..end]);
    let mut fields: Vec<String> = Vec::new();
    for line in header.split('\n').map(|line| line.trim_end_matches('\r')) {
        match fields.last_mut() {
            Some(field) if line.starts_with([' ', '\t']) => {
                field.push_str("\r\n");
                field.push_str(line);
            }
            _ => fields.push(line.to_string()),
        }
    }
    let name_of = |field: &str| {
        field
            .split_once(':')
            .map(|(name, _)| name.trim().to_ascii_lowercase())
    };
    let dropped: Vec<String> = drop.iter().map(|name| name.to_ascii_lowercase()).collect();
    let mut kept: Vec<String> = fields
        .into_iter()
        .filter(|field| {
            name_of(field)
                .is_none_or(|name| !dropped.contains(&name) && (date.is_none() || name != "date"))
        })
        .collect();
    if let Some(date) = date {
        kept.push(format!("Date: {date}"));
    }
    let mut out = kept.join("\r\n").into_bytes();
    out.extend_from_slice(b"\r\n\r\n");
    if separator > 0 {
        out.extend_from_slice(&raw[end + separator..]);
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Epoch ms as an RFC 5322 date in UTC: `Tue, 03 Nov 2026 07:00:00 +0000`.
pub fn rfc5322_utc(ms: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let iso = iso_utc(ms);
    let number = |range: std::ops::Range<usize>| iso[range].parse::<usize>().unwrap_or(1);
    let days = ms / 1000 / 86_400;
    format!(
        "{}, {} {} {} {} +0000",
        DAYS[(days % 7) as usize],
        &iso[8..10],
        MONTHS[number(5..7).saturating_sub(1) % 12],
        &iso[0..4],
        &iso[11..19]
    )
}

/// Epoch ms as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn iso_utc(ms: u64) -> String {
    let seconds = ms / 1000;
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Howard Hinnant's civil-from-days.
    let z = days as i64 + 719_468;
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

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` as epoch ms.
pub fn parse_iso_utc(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    // Howard Hinnant's days-from-civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok().map(|seconds| seconds * 1000)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    let response = http
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Fails unless the server said yes.
async fn expect_success(response: reqwest::Response) -> Result<(), String> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status().as_u16()))
    }
}

/// Gmail (`base`: `…/users/me/`): sends the drafts that are due; their subjects.
pub async fn gmail_send_due(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    device: &str,
    now: u64,
) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct Drafts {
        #[serde(default)]
        drafts: Vec<Draft>,
    }
    #[derive(Deserialize)]
    struct Draft {
        id: String,
        message: Id,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Id {
        id: String,
        #[serde(default)]
        thread_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct Meta {
        #[serde(default)]
        payload: Payload,
    }
    #[derive(Default, Deserialize)]
    struct Payload {
        #[serde(default)]
        headers: Vec<Header>,
    }
    #[derive(Deserialize)]
    struct Header {
        name: String,
        value: String,
    }
    #[derive(Deserialize)]
    struct Raw {
        raw: String,
    }

    let list: Drafts = get_json(
        http,
        &format!("{base}drafts?maxResults={MAX_DRAFTS}"),
        token,
    )
    .await?;
    let mut sent = Vec::new();
    for draft in list.drafts {
        let id = &draft.message.id;
        let meta: Meta = get_json(
            http,
            &format!(
                "{base}messages/{id}?format=metadata&metadataHeaders={SEND_AT_HEADER}&metadataHeaders=Subject"
            ),
            token,
        )
        .await?;
        let header = |name: &str| {
            meta.payload
                .headers
                .iter()
                .find(|header| header.name.eq_ignore_ascii_case(name))
                .map(|header| header.value.as_str())
        };
        let Some(marker) = header(SEND_AT_HEADER).and_then(Marker::parse) else {
            continue;
        };
        if !marker.is_due(now, device) {
            continue;
        }
        let subject = header("Subject").unwrap_or_default().to_string();
        let raw: Raw = get_json(http, &format!("{base}messages/{id}?format=raw"), token).await?;
        let bytes = BASE64URL
            .decode(raw.raw.trim())
            .map_err(|e| e.to_string())?;
        let message = rewrite_headers(&bytes, &[SEND_AT_HEADER], Some(&rfc5322_utc(now)));
        let response = http
            .post(format!("{base}drafts/send"))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "id": draft.id,
                "message": {
                    "raw": BASE64URL.encode(message),
                    "threadId": draft.message.thread_id,
                },
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        // Another action0 sent it meanwhile (the draft is gone): fine.
        if response.status().as_u16() == 404 {
            continue;
        }
        expect_success(response).await?;
        sent.push(subject);
    }
    Ok(sent)
}

/// Personal Outlook accounts (`base`: `…/v1.0/me/`): sends the drafts that
/// are due, their time cleared first; their subjects.
pub async fn graph_send_due(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    device: &str,
    now: u64,
) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct List {
        #[serde(default)]
        value: Vec<Message>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Message {
        id: String,
        #[serde(default)]
        subject: Option<String>,
        #[serde(default)]
        single_value_extended_properties: Vec<Property>,
    }
    #[derive(Deserialize)]
    struct Property {
        id: String,
        #[serde(default)]
        value: Option<String>,
    }

    let mut url = url::Url::parse(&format!("{base}mailFolders/drafts/messages"))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("$select", "id,subject")
        .append_pair("$top", &MAX_DRAFTS.to_string())
        .append_pair(
            "$expand",
            &format!("singleValueExtendedProperties($filter=id eq '{GRAPH_PROPERTY}')"),
        );
    let list: List = get_json(http, url.as_str(), token).await?;
    let mut sent = Vec::new();
    for message in list.value {
        let Some(marker) = message
            .single_value_extended_properties
            .iter()
            .find(|property| property.id.eq_ignore_ascii_case(GRAPH_PROPERTY))
            .and_then(|property| property.value.as_deref())
            .and_then(Marker::parse)
        else {
            continue;
        };
        if !marker.is_due(now, device) {
            continue;
        }
        let path = format!("{base}messages/{}", message.id);
        let cleared = http
            .patch(&path)
            .bearer_auth(token)
            .json(&serde_json::json!({
                "singleValueExtendedProperties": [{ "id": GRAPH_PROPERTY, "value": "" }],
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if cleared.status().as_u16() == 404 {
            continue;
        }
        expect_success(cleared).await?;
        let response = http
            .post(format!("{path}/send"))
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_LENGTH, "0")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        expect_success(response).await?;
        sent.push(message.subject.unwrap_or_default());
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NOW: u64 = 1_793_689_200_000; // 2026-11-03T07:00:00Z

    #[test]
    fn reads_markers_and_when_they_are_due() {
        let mine = Marker::parse("2026-11-03T07:00:00.000Z; by=me").unwrap();
        assert_eq!(mine.at, NOW);
        assert_eq!(mine.by.as_deref(), Some("me"));
        assert!(!mine.is_due(NOW - 1, "me"));
        assert!(mine.is_due(NOW, "me"));
        // Another action0 waits two minutes; nobody sends it 31 minutes late.
        assert!(!mine.is_due(NOW, "other"));
        assert!(mine.is_due(NOW + 2 * 60 * 1000, "other"));
        assert!(!mine.is_due(NOW + 31 * 60 * 1000, "me"));
        assert!(Marker::parse("soon").is_none());
    }

    #[test]
    fn rewrites_only_the_header() {
        let raw = b"From: me@example.com\r\nX-Action0-Send-At: 2026-11-03T07:00:00.000Z;\r\n by=me\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\nSubject: Hi\r\n\r\nX-Action0-Send-At: stays\r\n";
        let out = rewrite_headers(raw, &[SEND_AT_HEADER], Some(&rfc5322_utc(NOW)));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "From: me@example.com\r\nSubject: Hi\r\nDate: Tue, 03 Nov 2026 07:00:00 +0000\r\n\r\nX-Action0-Send-At: stays\r\n"
        );
    }

    #[tokio::test]
    async fn sends_due_gmail_drafts_without_the_marker() {
        let server = MockServer::start().await;
        let base = format!("{}/", server.uri());
        let raw = "From: me@example.com\r\nX-Action0-Send-At: 2026-11-03T06:59:00.000Z; by=me\r\nSubject: Hi\r\n\r\nHello\r\n";
        Mock::given(method("GET"))
            .and(path("/drafts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "drafts": [
                    { "id": "d1", "message": { "id": "m1", "threadId": "t1" } },
                    { "id": "d2", "message": { "id": "m2" } },
                ],
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/messages/m1"))
            .and(query_param("format", "metadata"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payload": { "headers": [
                    { "name": "X-Action0-Send-At", "value": "2026-11-03T06:59:00.000Z; by=me" },
                    { "name": "Subject", "value": "Hi" },
                ] },
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/messages/m2"))
            .and(query_param("format", "metadata"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "payload": { "headers": [] } })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/messages/m1"))
            .and(query_param("format", "raw"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "raw": BASE64URL.encode(raw) })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/drafts/send"))
            .and(body_partial_json(serde_json::json!({
                "id": "d1",
                "message": { "threadId": "t1" },
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "s1" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::new();
        let sent = gmail_send_due(&http, &base, "token", "me", NOW)
            .await
            .unwrap();
        assert_eq!(sent, vec!["Hi".to_string()]);
        let requests = server.received_requests().await.unwrap();
        let send = requests
            .iter()
            .find(|request| request.url.path() == "/drafts/send")
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&send.body).unwrap();
        let message = BASE64URL
            .decode(body["message"]["raw"].as_str().unwrap())
            .unwrap();
        let message = String::from_utf8(message).unwrap();
        assert!(!message.contains("X-Action0-Send-At"));
        assert!(message.contains("Date: Tue, 03 Nov 2026 07:00:00 +0000"));
    }
}
