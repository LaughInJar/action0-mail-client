//! The background check for new mail (Android). The Kotlin side's
//! WorkManager job runs it about every 15 minutes, as the system allows,
//! while the app isn't open: it asks each account for unread Inbox mail
//! that arrived since the last check and returns what to notify. Kept in
//! `background.json` between runs: whether it's on, the notifications'
//! texts (in the UI's language), and per account when it last checked and
//! which messages it notified (ids only, no content).
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::oauth::providers::{Provider, TokenResponse};
use crate::vault::{Accounts, StoredAccount};

const FILE: &str = "background.json";
/// Message ids remembered per account (so nothing is notified twice).
const MAX_NOTIFIED: usize = 200;
/// Messages asked for per account and check.
const MAX_PER_CHECK: usize = 10;
/// More new messages than this make one notification for the account.
const GROUP_ABOVE: usize = 3;
/// Mail received this long before the last check still counts (clocks
/// differ, and servers list mail a moment after receiving it).
const MARGIN_MS: u64 = 5 * 60 * 1000;

/// The notifications' texts, in the UI's language.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Texts {
    /// For several new messages; `{count}` is replaced ("3 new messages").
    pub new_messages: String,
    /// For a message without a subject.
    pub no_subject: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    enabled: bool,
    texts: Texts,
    #[serde(default)]
    accounts: BTreeMap<String, Seen>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Seen {
    /// When it last checked (epoch ms); 0: never.
    checked: u64,
    /// Message ids notified, oldest first.
    notified: Vec<String>,
}

fn load(dir: &Path) -> State {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(dir: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), bytes).map_err(|e| e.to_string())
}

/// Turns the check on or off (from the UI's settings).
pub fn configure(dir: &Path, enabled: bool, texts: Texts) -> Result<(), String> {
    let mut state = load(dir);
    state.enabled = enabled;
    state.texts = texts;
    save(dir, &state)
}

/// A notification to show; tapping it opens `url`.
#[derive(Debug, PartialEq, Serialize)]
pub struct Notice {
    pub tag: String,
    pub title: String,
    pub body: String,
    pub url: String,
}

/// A new message, as much as a notification needs.
#[derive(Debug, PartialEq)]
struct NewMail {
    id: String,
    from: String,
    subject: String,
    /// Epoch ms.
    received: u64,
}

/// Where the providers are (tests use a local server).
pub struct Apis {
    pub gmail: String,
    pub graph: String,
    pub microsoft_token: String,
}

impl Default for Apis {
    fn default() -> Self {
        Self {
            gmail: "https://gmail.googleapis.com/gmail/v1/users/me/".into(),
            graph: "https://graph.microsoft.com/v1.0/me/".into(),
            microsoft_token: Provider::Microsoft.token_endpoint().into(),
        }
    }
}

/// Checks every account. `google_tokens`: access tokens of the Google
/// accounts by account id (from Play services; without one, the account
/// is skipped). An account seen for the first time only starts counting.
/// An account whose check fails is tried again next time from where it was.
pub async fn check(
    http: &reqwest::Client,
    dir: &Path,
    accounts: &Accounts,
    google_tokens: &HashMap<String, String>,
    now: u64,
    apis: &Apis,
) -> Vec<Notice> {
    let mut state = load(dir);
    if !state.enabled {
        return Vec::new();
    }
    let texts = state.texts.clone();
    let mut notices = Vec::new();
    for (key, account) in accounts {
        let seen = state.accounts.entry(key.clone()).or_default();
        if seen.checked == 0 {
            seen.checked = now;
            continue;
        }
        let since = seen.checked.saturating_sub(MARGIN_MS);
        let found = match account.provider {
            Provider::Google => match google_tokens.get(key) {
                Some(token) => gmail_new(http, apis, token, since).await,
                None => continue,
            },
            Provider::Microsoft => match microsoft_token(http, apis, account).await {
                Ok(token) => graph_new(http, apis, &token, since).await,
                Err(_) => continue,
            },
        };
        let Ok(found) = found else { continue };
        let fresh: Vec<NewMail> = found
            .into_iter()
            .filter(|mail| mail.received >= since && !seen.notified.contains(&mail.id))
            .collect();
        seen.checked = now;
        seen.notified
            .extend(fresh.iter().map(|mail| mail.id.clone()));
        let excess = seen.notified.len().saturating_sub(MAX_NOTIFIED);
        seen.notified.drain(..excess);
        notices.extend(notices_for(key, account, &fresh, &texts));
    }
    // Accounts that are gone are forgotten.
    state.accounts.retain(|key, _| accounts.contains_key(key));
    let _ = save(dir, &state);
    notices
}

fn notices_for(key: &str, account: &StoredAccount, mail: &[NewMail], texts: &Texts) -> Vec<Notice> {
    let enc = |text: &str| {
        percent_encoding::utf8_percent_encode(text, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    if mail.len() > GROUP_ABOVE {
        return vec![Notice {
            tag: format!("{key}/new"),
            title: account.email.clone(),
            body: texts
                .new_messages
                .replace("{count}", &mail.len().to_string()),
            url: format!("action0://open?account={}", enc(key)),
        }];
    }
    mail.iter()
        .map(|mail| Notice {
            tag: format!("{key}/{}", mail.id),
            title: mail.from.clone(),
            body: if mail.subject.trim().is_empty() {
                texts.no_subject.clone()
            } else {
                mail.subject.clone()
            },
            url: format!(
                "action0://open?account={}&message={}",
                enc(key),
                enc(&mail.id)
            ),
        })
        .collect()
}

/// A sender as a notification shows it: the name, else the address.
fn sender(name: Option<&str>, address: &str) -> String {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => name.trim_matches('"').to_string(),
        None => address.to_string(),
    }
}

/// `"Anna Berger" <anna@example.org>` → `Anna Berger`.
fn from_header(value: &str) -> String {
    match value.split_once('<') {
        Some((name, address)) => sender(Some(name), address.trim_end_matches('>')),
        None => value.trim().to_string(),
    }
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

/// Gmail: unread Inbox mail received after `since`, with sender and subject.
async fn gmail_new(
    http: &reqwest::Client,
    apis: &Apis,
    token: &str,
    since: u64,
) -> Result<Vec<NewMail>, String> {
    #[derive(Deserialize)]
    struct List {
        #[serde(default)]
        messages: Vec<Id>,
    }
    #[derive(Deserialize)]
    struct Id {
        id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Message {
        id: String,
        internal_date: String,
        payload: Payload,
    }
    #[derive(Deserialize)]
    struct Payload {
        #[serde(default)]
        headers: Vec<Header>,
    }
    #[derive(Deserialize)]
    struct Header {
        name: String,
        value: String,
    }

    let mut list =
        url::Url::parse(&format!("{}messages", apis.gmail)).map_err(|e| e.to_string())?;
    list.query_pairs_mut()
        .append_pair("q", &format!("in:inbox is:unread after:{}", since / 1000))
        .append_pair("maxResults", &MAX_PER_CHECK.to_string());
    let ids: List = get_json(http, list.as_str(), token).await?;
    let mut found = Vec::new();
    for Id { id } in ids.messages {
        let url = format!(
            "{}messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject",
            apis.gmail
        );
        let message: Message = get_json(http, &url, token).await?;
        let header = |name: &str| {
            message
                .payload
                .headers
                .iter()
                .find(|header| header.name.eq_ignore_ascii_case(name))
                .map(|header| header.value.clone())
                .unwrap_or_default()
        };
        found.push(NewMail {
            from: from_header(&header("From")),
            subject: header("Subject"),
            received: message.internal_date.parse().unwrap_or_default(),
            id: message.id,
        });
    }
    Ok(found)
}

/// A Microsoft access token from the refresh token in the vault. (The new
/// refresh token Microsoft hands out isn't kept: the app keeps its own, and
/// earlier ones stay valid until they expire.)
async fn microsoft_token(
    http: &reqwest::Client,
    apis: &Apis,
    account: &StoredAccount,
) -> Result<String, String> {
    let form =
        Provider::Microsoft.refresh_form(&account.client, &account.refresh_token, &account.scopes);
    let response = http
        .post(&apis.microsoft_token)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let tokens: TokenResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(tokens.access_token)
}

/// Graph: unread Inbox mail received after `since`.
async fn graph_new(
    http: &reqwest::Client,
    apis: &Apis,
    token: &str,
    since: u64,
) -> Result<Vec<NewMail>, String> {
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
        from: Option<From>,
        received_date_time: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct From {
        email_address: Address,
    }
    #[derive(Deserialize)]
    struct Address {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        address: Option<String>,
    }

    let mut url = url::Url::parse(&format!("{}mailFolders/inbox/messages", apis.graph))
        .map_err(|e| e.to_string())?;
    // Graph wants the $orderby property first in $filter.
    url.query_pairs_mut()
        .append_pair(
            "$filter",
            &format!("receivedDateTime gt {} and isRead eq false", iso_utc(since)),
        )
        .append_pair("$orderby", "receivedDateTime desc")
        .append_pair("$top", &MAX_PER_CHECK.to_string())
        .append_pair("$select", "id,subject,from,receivedDateTime");
    let list: List = get_json(http, url.as_str(), token).await?;
    Ok(list
        .value
        .into_iter()
        .map(|message| {
            let (name, address) = message
                .from
                .map(|from| (from.email_address.name, from.email_address.address))
                .unwrap_or_default();
            NewMail {
                from: sender(name.as_deref(), address.as_deref().unwrap_or_default()),
                subject: message.subject.unwrap_or_default(),
                received: parse_iso_utc(&message.received_date_time).unwrap_or_default(),
                id: message.id,
            }
        })
        .collect())
}

/// Epoch ms as `YYYY-MM-DDTHH:MM:SSZ`.
fn iso_utc(ms: u64) -> String {
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
fn parse_iso_utc(text: &str) -> Option<u64> {
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

/// The JNI entry points the Kotlin side's background job calls.
#[cfg(target_os = "android")]
mod jni_entry {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use jni::JNIEnv;
    use jni::objects::{JClass, JString};
    use jni::sys::jstring;
    use serde::Serialize;

    use crate::vault::{FixedKey, Vault};

    fn text(env: &mut JNIEnv, value: &JString) -> String {
        env.get_string(value).map(Into::into).unwrap_or_default()
    }

    fn answer(env: &mut JNIEnv, json: String) -> jstring {
        env.new_string(json)
            .map(|value| value.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    fn vault(dir: &str, key: &str) -> Option<Vault> {
        let key = STANDARD.decode(key).ok()?;
        let vault = Vault::open(PathBuf::from(dir).join("accounts.vault"), &FixedKey(key));
        vault.persistent().then_some(vault)
    }

    #[derive(Serialize)]
    struct Account {
        key: String,
        provider: crate::oauth::providers::Provider,
        email: String,
        scopes: Vec<String>,
    }

    /// The signed-in accounts (no tokens): `[{key, provider, email, scopes}]`.
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_action0_plugin_Native_accounts<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        dir: JString<'local>,
        key: JString<'local>,
    ) -> jstring {
        let (dir, key) = (text(&mut env, &dir), text(&mut env, &key));
        let json = std::panic::catch_unwind(|| {
            let accounts: Vec<Account> = vault(&dir, &key)
                .map(|vault| vault.all())
                .unwrap_or_default()
                .into_iter()
                .map(|(key, account)| Account {
                    key,
                    provider: account.provider,
                    email: account.email,
                    scopes: account.scopes,
                })
                .collect();
            serde_json::to_string(&accounts).unwrap_or_else(|_| "[]".into())
        })
        .unwrap_or_else(|_| "[]".into());
        answer(&mut env, json)
    }

    /// One check: the notifications to show, `[{tag, title, body, url}]`.
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_app_action0_plugin_Native_check<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        dir: JString<'local>,
        key: JString<'local>,
        google_tokens: JString<'local>,
    ) -> jstring {
        let (dir, key) = (text(&mut env, &dir), text(&mut env, &key));
        let tokens = text(&mut env, &google_tokens);
        let json = std::panic::catch_unwind(|| {
            // The job may run without the app (and so without its setup).
            let _ = rustls::crypto::ring::default_provider().install_default();
            let Some(vault) = vault(&dir, &key) else {
                return "[]".to_string();
            };
            let tokens: HashMap<String, String> = serde_json::from_str(&tokens).unwrap_or_default();
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return "[]".to_string();
            };
            let http = crate::net::http_client();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or_default();
            let notices = runtime.block_on(super::check(
                &http,
                &PathBuf::from(&dir),
                &vault.all(),
                &tokens,
                now,
                &super::Apis::default(),
            ));
            serde_json::to_string(&notices).unwrap_or_else(|_| "[]".into())
        })
        .unwrap_or_else(|_| "[]".into());
        answer(&mut env, json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::providers::Client;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NOW: u64 = 1_792_000_000_000;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("action0-bg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn texts() -> Texts {
        Texts {
            new_messages: "{count} new messages".into(),
            no_subject: "(no subject)".into(),
        }
    }

    fn account(provider: Provider, email: &str) -> StoredAccount {
        StoredAccount {
            provider,
            client: Client {
                id: "client".into(),
                secret: None,
            },
            refresh_token: "refresh".into(),
            scopes: vec!["scope".into()],
            email: email.into(),
            tenant: None,
        }
    }

    /// A client, with the crypto provider the app installs at start.
    fn http() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::new()
    }

    fn apis(server: &MockServer) -> Apis {
        Apis {
            gmail: format!("{}/gmail/", server.uri()),
            graph: format!("{}/graph/", server.uri()),
            microsoft_token: format!("{}/token", server.uri()),
        }
    }

    async fn gmail_message(
        server: &MockServer,
        id: &str,
        from: &str,
        subject: &str,
        received: u64,
    ) {
        Mock::given(method("GET"))
            .and(path(format!("/gmail/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id,
                "internalDate": received.to_string(),
                "payload": { "headers": [
                    { "name": "From", "value": from },
                    { "name": "Subject", "value": subject },
                ]},
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn notifies_new_gmail_once_and_starts_counting_for_new_accounts() {
        let dir = temp_dir("gmail");
        configure(&dir, true, texts()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/messages"))
            .and(query_param(
                "q",
                format!("in:inbox is:unread after:{}", (NOW - MARGIN_MS) / 1000),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "messages": [{ "id": "m1" }, { "id": "old" }] }),
            ))
            .mount(&server)
            .await;
        gmail_message(
            &server,
            "m1",
            "\"Anna Berger\" <anna@example.org>",
            "Lunch?",
            NOW + 1000,
        )
        .await;
        gmail_message(&server, "old", "bob@example.org", "", NOW - MARGIN_MS - 1).await;

        let http = http();
        let accounts: Accounts = [(
            "gmail:me@example.com".to_string(),
            account(Provider::Google, "me@example.com"),
        )]
        .into();
        let tokens: HashMap<String, String> =
            [("gmail:me@example.com".to_string(), "t".to_string())].into();

        // The first time only notes when.
        assert!(
            check(&http, &dir, &accounts, &tokens, NOW, &apis(&server))
                .await
                .is_empty()
        );
        let later = NOW + 15 * 60 * 1000;
        let notices = check(&http, &dir, &accounts, &tokens, later, &apis(&server)).await;
        assert_eq!(
            notices,
            vec![Notice {
                tag: "gmail:me@example.com/m1".into(),
                title: "Anna Berger".into(),
                body: "Lunch?".into(),
                url: "action0://open?account=gmail%3Ame%40example%2Ecom&message=m1".into(),
            }]
        );
        // Already notified: not again.
        let again = check(
            &http,
            &dir,
            &accounts,
            &tokens,
            later + 1000,
            &apis(&server),
        )
        .await;
        assert!(again.is_empty());
    }

    #[tokio::test]
    async fn groups_many_messages_and_reads_graph() {
        let dir = temp_dir("graph");
        configure(&dir, true, texts()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "access_token": "a" })),
            )
            .mount(&server)
            .await;
        let messages: Vec<_> = (0..5)
            .map(|i| {
                serde_json::json!({
                    "id": format!("g{i}"),
                    "subject": "Hi",
                    "from": { "emailAddress": { "name": "Max", "address": "max@contoso.com" } },
                    "receivedDateTime": iso_utc(NOW + 60_000),
                })
            })
            .collect();
        Mock::given(method("GET"))
            .and(path("/graph/mailFolders/inbox/messages"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "value": messages })),
            )
            .mount(&server)
            .await;

        let http = http();
        let accounts: Accounts = [(
            "microsoft:max@contoso.com".to_string(),
            account(Provider::Microsoft, "max@contoso.com"),
        )]
        .into();
        let none = HashMap::new();
        check(&http, &dir, &accounts, &none, NOW, &apis(&server)).await;
        let notices = check(&http, &dir, &accounts, &none, NOW + 900_000, &apis(&server)).await;
        assert_eq!(
            notices,
            vec![Notice {
                tag: "microsoft:max@contoso.com/new".into(),
                title: "max@contoso.com".into(),
                body: "5 new messages".into(),
                url: "action0://open?account=microsoft%3Amax%40contoso%2Ecom".into(),
            }]
        );
    }

    #[tokio::test]
    async fn does_nothing_while_off_or_without_a_token() {
        let dir = temp_dir("off");
        let server = MockServer::start().await;
        let http = http();
        let accounts: Accounts = [(
            "gmail:me@example.com".to_string(),
            account(Provider::Google, "me@example.com"),
        )]
        .into();
        assert!(
            check(&http, &dir, &accounts, &HashMap::new(), NOW, &apis(&server))
                .await
                .is_empty()
        );
        configure(&dir, true, texts()).unwrap();
        check(&http, &dir, &accounts, &HashMap::new(), NOW, &apis(&server)).await;
        // No token for the account: skipped, and no request was made.
        assert!(
            check(
                &http,
                &dir,
                &accounts,
                &HashMap::new(),
                NOW + 900_000,
                &apis(&server)
            )
            .await
            .is_empty()
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn formats_and_reads_utc_times() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_792_000_000_000), "2026-10-14T17:46:40Z");
        assert_eq!(
            parse_iso_utc("2026-10-14T17:46:40Z"),
            Some(1_792_000_000_000)
        );
        assert_eq!(
            parse_iso_utc("2026-10-14T17:46:40.123Z"),
            Some(1_792_000_000_000)
        );
        assert_eq!(
            parse_iso_utc("2024-02-29T12:00:00Z")
                .map(iso_utc)
                .as_deref(),
            Some("2024-02-29T12:00:00Z")
        );
        assert_eq!(parse_iso_utc("soon"), None);
    }

    #[test]
    fn names_senders() {
        assert_eq!(
            from_header("\"Anna Berger\" <anna@example.org>"),
            "Anna Berger"
        );
        assert_eq!(from_header("<anna@example.org>"), "anna@example.org");
        assert_eq!(from_header("bob@example.org"), "bob@example.org");
    }
}
