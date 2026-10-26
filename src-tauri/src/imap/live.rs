//! Tests against a real server (e.g. Dovecot and Postfix in Docker), run
//! only when asked: `ACTION0_IMAP_TEST=1 cargo test --locked -- --ignored live`.
//! The mail operations work in folders of their own (`action0 test …`),
//! which they delete again (into Trash, then for good).
//!
//! - `ACTION0_IMAP_HOST`, `ACTION0_IMAP_PORT` (993), `ACTION0_IMAP_SECURITY`
//!   (`tls` or `starttls`), `ACTION0_IMAP_USER`, `ACTION0_IMAP_PASSWORD`
//! - `ACTION0_SMTP_HOST` (the IMAP host), `ACTION0_SMTP_PORT` (465),
//!   `ACTION0_SMTP_SECURITY` (`tls`)
//! - `ACTION0_SMTP_TO`: an address to send a test mail to (none: no mail)
//!
//! A certificate the system doesn't trust (a container's self-signed one)
//! is trusted the way the UI does it: the refusal names it, then it's pinned.

use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::vault::FixedKey;

/// The account from the environment; `None` unless `ACTION0_IMAP_TEST` is set.
fn configured() -> Option<ImapAccount> {
    std::env::var_os("ACTION0_IMAP_TEST")?;
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let security = |name: &str| match var(name).as_deref() {
        Some("starttls") => Security::Starttls,
        _ => Security::Tls,
    };
    let host = var("ACTION0_IMAP_HOST").expect("ACTION0_IMAP_HOST");
    let user = var("ACTION0_IMAP_USER").expect("ACTION0_IMAP_USER");
    let _ = rustls::crypto::ring::default_provider().install_default();
    Some(ImapAccount {
        address: if user.contains('@') {
            user.clone()
        } else {
            format!("{user}@example.org")
        },
        name: "action0 test".into(),
        settings: MailServerSettings {
            imap: MailServer {
                host: host.clone(),
                port: var("ACTION0_IMAP_PORT").map_or(993, |p| p.parse().expect("a port")),
                security: security("ACTION0_IMAP_SECURITY"),
            },
            smtp: MailServer {
                host: var("ACTION0_SMTP_HOST").unwrap_or(host),
                port: var("ACTION0_SMTP_PORT").map_or(465, |p| p.parse().expect("a port")),
                security: security("ACTION0_SMTP_SECURITY"),
            },
            username: user,
        },
        auth: ImapAuth::Password {
            password: var("ACTION0_IMAP_PASSWORD").expect("ACTION0_IMAP_PASSWORD"),
        },
        pinned: None,
        max_bytes: None,
    })
}

fn password(account: &ImapAccount) -> &str {
    match &account.auth {
        ImapAuth::Password { password } => password,
        ImapAuth::OAuth { .. } => unreachable!("password accounts only"),
    }
}

/// Connects to `server` like adding an account would: if the system
/// refuses the certificate, pins the one it named and tries again.
async fn trusting(account: &mut ImapAccount) {
    let login = Login {
        server: &account.settings.imap,
        username: &account.settings.username,
        secret: Secret::Password(password(account)),
    };
    if let Err(error) = session::connect(&login, &tls::Connector::new(None).unwrap()).await {
        assert_eq!(error.kind, ErrorKind::Untrusted, "{error:?}");
        account.pinned = Some(error.certificate.expect("its details").sha256);
    }
}

#[tokio::test]
#[ignore]
async fn live_logs_in_and_opens_the_inbox() {
    let Some(mut account) = configured() else {
        return;
    };
    trusting(&mut account).await;
    let tls = tls::Connector::new(account.pinned.as_deref()).unwrap();
    let login = Login {
        server: &account.settings.imap,
        username: &account.settings.username,
        secret: Secret::Password(password(&account)),
    };
    let mut session = session::connect(&login, &tls).await.unwrap();
    assert!(session.capabilities.has("IMAP4REV1") || session.capabilities.has("IMAP4REV2"));
    let inbox = session
        .open_folder("INBOX", Access::ReadOnly)
        .await
        .unwrap();
    assert!(inbox.mailbox.uid_validity.is_some());
    session.ping().await.unwrap();
    session.logout().await;

    let wrong = Login {
        secret: Secret::Password("not the password"),
        ..login
    };
    let tls = tls::Connector::new(account.pinned.as_deref()).unwrap();
    let error = session::connect(&wrong, &tls).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Auth);
}

#[tokio::test]
#[ignore]
async fn live_keeps_sessions_in_the_pool() {
    let Some(mut account) = configured() else {
        return;
    };
    trusting(&mut account).await;
    let dir = std::env::temp_dir().join(format!("action0-imap-live-{}", std::process::id()));
    let imap = Imap::new(
        crate::net::http_client(),
        LazyVault::new(dir.join("imap.vault"), Arc::new(FixedKey(vec![3; 32]))),
    );
    let key = account.key();
    imap.vault().put(&key, account);
    let first = imap.session(&key).await.unwrap();
    assert!(!first.reused());
    drop(first);
    let again = imap.session(&key).await.unwrap();
    assert!(again.reused());
    drop(again);
    let selected = imap
        .run(&key, |session| {
            Box::pin(async move {
                let selected = session.open_folder("INBOX", Access::ReadOnly).await?;
                Ok(selected.path.clone())
            })
        })
        .await
        .unwrap();
    assert_eq!(selected, "INBOX");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore]
async fn live_checks_smtp_and_sends() {
    let Some(mut account) = configured() else {
        return;
    };
    trusting(&mut account).await;
    let login = Login {
        server: &account.settings.smtp,
        username: &account.settings.username,
        secret: Secret::Password(password(&account)),
    };
    let tls = tls::Connector::new(account.pinned.as_deref()).unwrap();
    let size = smtp::check(&login, &tls).await.unwrap();
    println!("SMTP SIZE: {size:?}");
    let Ok(to) = std::env::var("ACTION0_SMTP_TO") else {
        return;
    };
    let message = format!(
        "From: <{from}>\r\nTo: <{to}>\r\nSubject: action0 test\r\nMessage-ID: <{id}@action0.test>\r\n\r\nHello from the test.\r\n.leading dot\r\n",
        from = account.address,
        id = crate::oauth::now_ms(),
    );
    let envelope = Envelope {
        from: account.address.clone(),
        to: vec![to],
    };
    let tls = tls::Connector::new(account.pinned.as_deref()).unwrap();
    smtp::send(&login, &tls, &envelope, message.as_bytes())
        .await
        .unwrap();
}

/// An `Imap` with the account kept, in a folder of its own.
fn kept(account: &ImapAccount, name: &str) -> (Imap, String, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("action0-imap-live-{name}-{}", std::process::id()));
    let imap = Imap::new(
        crate::net::http_client(),
        LazyVault::new(dir.join("imap.vault"), Arc::new(FixedKey(vec![3; 32]))),
    );
    let key = account.key();
    imap.vault().put(&key, account.clone());
    (imap, key, dir)
}

async fn call(imap: &Imap, key: &str, name: &str, request: Value) -> Value {
    match calls::call(imap, key, name, request).await {
        Ok(answer) => answer,
        Err(error) => panic!("{name}: {error:?}"),
    }
}

fn test_message(account: &ImapAccount, subject: &str) -> Vec<u8> {
    format!(
        "From: Live Test <live@example.org>\r\nTo: <{to}>\r\nSubject: {subject}\r\nMessage-ID: <{id}@action0.test>\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHello from the live test, Grüße.\r\n",
        to = account.address,
        id = crate::oauth::now_ms(),
    )
    .into_bytes()
}

#[tokio::test]
#[ignore]
async fn live_lists_reads_changes_and_moves_mail() {
    let Some(mut account) = configured() else {
        return;
    };
    trusting(&mut account).await;
    let (imap, key, dir) = kept(&account, "mail");

    let folders = call(&imap, &key, "folders", json!({})).await;
    let folders = folders.as_array().unwrap();
    assert!(folders.iter().any(|f| f["role"] == "inbox"), "{folders:?}");
    let name = format!("action0 test {}", crate::oauth::now_ms());
    let created = call(&imap, &key, "createFolder", json!({ "name": name })).await;
    let folder = created["id"].as_str().unwrap().to_string();
    let start = call(&imap, &key, "changes", json!({})).await;
    assert_eq!(start["reset"], false);

    let raw = test_message(&account, "action0 live Grüße");
    let id = calls::append(&imap, &key, &folder, &["\\Seen".into()], raw.clone())
        .await
        .unwrap();
    let page = call(
        &imap,
        &key,
        "list",
        json!({ "mailboxId": folder, "limit": 10 }),
    )
    .await;
    let row = &page["items"][0];
    assert_eq!(row["id"], id.as_str());
    assert_eq!(row["subject"], "action0 live Grüße");
    assert_eq!(row["flags"]["seen"], true);
    assert!(
        row["snippet"]
            .as_str()
            .unwrap()
            .starts_with("Hello from the live test")
    );
    let found = call(
        &imap,
        &key,
        "list",
        json!({ "mailboxId": folder, "search": "from:live subject:action0", "limit": 10 }),
    )
    .await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    let nothing = call(
        &imap,
        &key,
        "list",
        json!({ "mailboxId": folder, "search": "is:starred", "limit": 10 }),
    )
    .await;
    assert!(nothing["items"].as_array().unwrap().is_empty());

    let message = call(&imap, &key, "message", json!({ "id": id })).await;
    assert!(message["body"]["text"].as_str().unwrap().contains("Grüße"));
    let original = calls::bytes(&imap, &key, model::BytesRequest::Raw { id: id.clone() })
        .await
        .unwrap();
    assert_eq!(original, raw);

    call(
        &imap,
        &key,
        "flags",
        json!({ "ids": [id], "seen": false, "flagged": true }),
    )
    .await;
    let changes = call(&imap, &key, "changes", json!({ "token": start["token"] })).await;
    assert_eq!(changes["reset"], false, "{changes:?}");
    assert!(
        changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["message"]["id"] == id.as_str()
                && change["message"]["flags"]["flagged"] == true),
        "{changes:?}"
    );

    let threads = call(
        &imap,
        &key,
        "threads",
        json!({ "mailboxId": folder, "limit": 10 }),
    )
    .await;
    let thread_id = threads["items"][0]["id"].as_str().unwrap().to_string();
    let thread = call(&imap, &key, "thread", json!({ "id": thread_id })).await;
    assert!(
        thread
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == id.as_str())
    );

    let sub = call(
        &imap,
        &key,
        "createFolder",
        json!({ "name": "sub", "parentId": folder }),
    )
    .await;
    let sub = sub["id"].as_str().unwrap().to_string();
    call(&imap, &key, "move", json!({ "ids": [id], "to": sub })).await;
    let moved = call(&imap, &key, "message", json!({ "id": id })).await;
    assert_eq!(moved["mailboxIds"], json!([sub]));
    let read = call(&imap, &key, "markAllRead", json!({ "mailboxId": sub })).await;
    assert_eq!(read, json!([id]));
    let renamed = call(
        &imap,
        &key,
        "updateFolder",
        json!({ "id": sub, "name": "renamed" }),
    )
    .await;
    let renamed = renamed["id"].as_str().unwrap().to_string();
    let after_rename = call(&imap, &key, "message", json!({ "id": id })).await;
    assert_eq!(after_rename["mailboxIds"], json!([renamed]));
    call(&imap, &key, "delete", json!({ "ids": [id] })).await;
    assert_eq!(
        calls::call(&imap, &key, "message", json!({ "id": id }))
            .await
            .unwrap_err()
            .kind,
        ErrorKind::NotFound
    );

    // Into Trash, then for good.
    call(&imap, &key, "deleteFolder", json!({ "id": folder })).await;
    let folders = call(&imap, &key, "folders", json!({})).await;
    let trashed = folders
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name.as_str())
        .unwrap_or_else(|| panic!("{name} isn't in Trash: {folders:?}"))["id"]
        .as_str()
        .unwrap()
        .to_string();
    call(&imap, &key, "deleteFolder", json!({ "id": trashed })).await;
    let folders = call(&imap, &key, "folders", json!({})).await;
    assert!(
        !folders
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["name"] == name.as_str())
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(desktop)]
#[tokio::test]
#[ignore]
async fn live_idle_tells_of_new_mail() {
    let Some(mut account) = configured() else {
        return;
    };
    trusting(&mut account).await;
    let (imap, key, dir) = kept(&account, "idle");
    let mut watcher = imap.dedicated_session(&key).await.unwrap();
    if !watcher.capabilities.has("IDLE") {
        return;
    }
    let (told, mut changes) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        idle::idle(
            &mut watcher,
            std::time::Duration::from_secs(60),
            std::time::Duration::from_millis(200),
            move || {
                let _ = told.send(());
            },
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let id = calls::append(
        &imap,
        &key,
        "f:INBOX",
        &[],
        test_message(&account, "action0 live IDLE"),
    )
    .await
    .unwrap();
    let told = tokio::time::timeout(std::time::Duration::from_secs(15), changes.recv()).await;
    task.abort();
    call(&imap, &key, "delete", json!({ "ids": [id] })).await;
    assert!(matches!(told, Ok(Some(()))), "IDLE said nothing");
    let _ = std::fs::remove_dir_all(dir);
}
