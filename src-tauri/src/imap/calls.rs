//! The mail commands' work: `imap_call` by operation name (the operations
//! of `ImapCalls` in `bridge.ts`), `imap_bytes` and `imap_append`, each on a
//! pooled session of the account. Operations that may run twice run with
//! [`Imap::run`] (once more on a new connection if a kept one broke);
//! APPEND doesn't. A list, conversation list or change check whose answer
//! couldn't be read is fetched again without BODYSTRUCTURE.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::error::MailServerError;
use super::model::{
    BytesRequest, ChangesRequest, CreateFolder, FlagsRequest, IdRequest, IdsRequest, ListQuery,
    MailboxRequest, MoveRequest, UpdateFolder,
};
use super::session::ImapSession;
use super::state::Account;
use super::{Imap, folders, list, proto, read, sync, threads, write};

/// Runs `op` on a session of the account, with the account's memory and
/// the request (owned, as an attempt may run twice).
async fn with<R, T, F>(imap: &Imap, key: &str, request: R, op: F) -> Result<T, MailServerError>
where
    R: Send + Sync + 'static,
    F: for<'s> Fn(
        &'s mut ImapSession,
        Arc<Account>,
        Arc<R>,
    ) -> BoxFuture<'s, Result<T, MailServerError>>,
{
    let account = imap.mail.account(key);
    let request = Arc::new(request);
    imap.run(key, |session| op(session, account.clone(), request.clone()))
        .await
}

/// Runs `op` with BODYSTRUCTURE (`true`), and again without it if the
/// server's answer couldn't be read.
async fn rich_or_plain<R, T, F>(
    imap: &Imap,
    key: &str,
    request: R,
    op: F,
) -> Result<T, MailServerError>
where
    R: Clone + Send + Sync + 'static,
    F: for<'s> Fn(
        &'s mut ImapSession,
        Arc<Account>,
        Arc<R>,
        bool,
    ) -> BoxFuture<'s, Result<T, MailServerError>>,
{
    let rich = with(imap, key, request.clone(), |s, a, r| op(s, a, r, true)).await;
    match rich {
        Err(error) if proto::is_unreadable(&error) => {
            with(imap, key, request, |s, a, r| op(s, a, r, false)).await
        }
        other => other,
    }
}

fn read_request<T: DeserializeOwned>(request: Value) -> Result<T, MailServerError> {
    serde_json::from_value(request)
        .map_err(|error| MailServerError::server(format!("Bad request: {error}")))
}

fn answer<T: Serialize>(value: T) -> Result<Value, MailServerError> {
    serde_json::to_value(value).map_err(|error| MailServerError::server(error.to_string()))
}

/// `imap_call`: the operation `name` with its request; its answer.
pub async fn call(
    imap: &Imap,
    key: &str,
    name: &str,
    request: Value,
) -> Result<Value, MailServerError> {
    match name {
        "folders" => answer(
            with(imap, key, (), |s, a, _| {
                Box::pin(async move { folders::folders(s, &a).await })
            })
            .await?,
        ),
        "list" => {
            let request: ListQuery = read_request(request)?;
            answer(
                rich_or_plain(imap, key, request, |s, a, r, rich| {
                    Box::pin(async move { list::list(s, &a, &r, rich).await })
                })
                .await?,
            )
        }
        "threads" => {
            let request: ListQuery = read_request(request)?;
            answer(
                rich_or_plain(imap, key, request, |s, a, r, rich| {
                    Box::pin(async move { threads::threads(s, &a, &r, rich).await })
                })
                .await?,
            )
        }
        "thread" => {
            let request: IdRequest = read_request(request)?;
            answer(
                with(imap, key, request, |s, a, r| {
                    Box::pin(async move { threads::thread(s, &a, &r.id).await })
                })
                .await?,
            )
        }
        "message" => {
            let request: IdRequest = read_request(request)?;
            answer(
                with(imap, key, request, |s, a, r| {
                    Box::pin(async move { read::message(s, &a, &r.id).await })
                })
                .await?,
            )
        }
        "flags" => {
            let request: FlagsRequest = read_request(request)?;
            with(imap, key, request, |s, a, r| {
                Box::pin(async move { write::flags(s, &a, &r).await })
            })
            .await?;
            Ok(json!({}))
        }
        "move" => {
            let request: MoveRequest = read_request(request)?;
            with(imap, key, request, |s, a, r| {
                Box::pin(async move { write::move_to(s, &a, &r).await })
            })
            .await?;
            Ok(json!({}))
        }
        "delete" => {
            let request: IdsRequest = read_request(request)?;
            with(imap, key, request, |s, a, r| {
                Box::pin(async move { write::delete(s, &a, &r.ids).await })
            })
            .await?;
            Ok(json!({}))
        }
        "empty" => {
            let request: MailboxRequest = read_request(request)?;
            let deleted = with(imap, key, request, |s, a, r| {
                Box::pin(async move { write::empty(s, &a, &r.mailbox_id).await })
            })
            .await?;
            Ok(json!({ "deleted": deleted }))
        }
        "markAllRead" => {
            let request: MailboxRequest = read_request(request)?;
            answer(
                with(imap, key, request, |s, a, r| {
                    Box::pin(async move { write::mark_all_read(s, &a, &r.mailbox_id).await })
                })
                .await?,
            )
        }
        "createFolder" => {
            let request: CreateFolder = read_request(request)?;
            answer(
                with(imap, key, request, |s, a, r| {
                    Box::pin(async move { write::create_folder(s, &a, &r).await })
                })
                .await?,
            )
        }
        "updateFolder" => {
            let request: UpdateFolder = read_request(request)?;
            answer(
                with(imap, key, request, |s, a, r| {
                    Box::pin(async move { write::update_folder(s, &a, &r).await })
                })
                .await?,
            )
        }
        "deleteFolder" => {
            let request: IdRequest = read_request(request)?;
            with(imap, key, request, |s, a, r| {
                Box::pin(async move { write::delete_folder(s, &a, &r.id).await })
            })
            .await?;
            Ok(json!({}))
        }
        "changes" => {
            let request: ChangesRequest = read_request(request)?;
            answer(
                rich_or_plain(imap, key, request, |s, a, r, rich| {
                    Box::pin(async move { sync::changes(s, &a, &r, rich).await })
                })
                .await?,
            )
        }
        other => Err(MailServerError::server(format!(
            "There's no IMAP operation {other}."
        ))),
    }
}

/// `imap_bytes`: a message as it is, or one part decoded.
pub async fn bytes(
    imap: &Imap,
    key: &str,
    request: BytesRequest,
) -> Result<Vec<u8>, MailServerError> {
    with(imap, key, request, |s, a, r| {
        Box::pin(async move { read::bytes(s, &a, &r).await })
    })
    .await
}

/// `imap_append`: stores `message` in a folder; its id. Not tried twice (it
/// might be stored twice), so a kept session is checked first.
pub async fn append(
    imap: &Imap,
    key: &str,
    mailbox_id: &str,
    flags: &[String],
    message: Vec<u8>,
) -> Result<String, MailServerError> {
    let account = imap.mail.account(key);
    let mut session = imap.session(key).await?;
    if session.reused() && session.ping().await.is_err() {
        session.discard();
        session = imap.session(key).await?;
    }
    let result = write::append(
        &mut session,
        &account,
        mailbox_id,
        flags,
        message,
        proto::now_ms(),
    )
    .await;
    if result.as_ref().is_err_and(MailServerError::is_connection) {
        session.discard();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::account::{MailServer, Security};
    use crate::imap::error::ErrorKind;
    use crate::imap::session::{Login, Secret, Stream, login_on};
    use crate::imap::testing::scripted;
    use crate::vault::{FixedKey, LazyVault};

    #[tokio::test]
    async fn runs_operations_by_name_and_answers_json() {
        let (stream, script) = scripted(
            "
            S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] hi
            C: A0001 AUTHENTICATE PLAIN AHVzZXIAcGFzcw==
            S: A0001 OK in
            C: A0002 CAPABILITY
            S: * CAPABILITY IMAP4rev1
            S: A0002 OK done
            C: A0003 LIST \"\" \"*\"
            S: * LIST (\\HasNoChildren) \"/\" INBOX
            S: A0003 OK done
            C: A0004 STATUS \"INBOX\" (MESSAGES UNSEEN)
            S: * STATUS INBOX (MESSAGES 4 UNSEEN 1)
            S: A0004 OK done
            C: A0005 SELECT \"INBOX\"
            S: * 4 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0005 OK done
            C: A0006 STORE 1:* +FLAGS.SILENT (\\Deleted)
            S: A0006 OK done
            C: A0007 EXPUNGE
            S: A0007 OK done
            ",
        );
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
        let session = login_on(Box::new(stream) as Stream, true, &login)
            .await
            .unwrap();
        let dir = std::env::temp_dir().join(format!("action0-imap-calls-{}", std::process::id()));
        let _ = rustls::crypto::ring::default_provider().install_default();
        let imap = Imap::new(
            crate::net::http_client(),
            LazyVault::new(dir.join("imap.vault"), Arc::new(FixedKey(vec![1; 32]))),
        );
        let key = "imap:max@example.org";
        imap.pool(key).keep(session);

        let folders = call(&imap, key, "folders", json!({})).await.unwrap();
        assert_eq!(folders[0]["id"], "f:INBOX");
        assert_eq!(folders[0]["counts"], json!({"unread": 1, "total": 4}));
        assert_eq!(folders[1]["kind"], "view");
        let emptied = call(&imap, key, "empty", json!({"mailboxId": "f:INBOX"}))
            .await
            .unwrap();
        assert_eq!(emptied, json!({"deleted": 4}));
        script.await.unwrap().unwrap();

        let unknown = call(&imap, key, "nothing", json!({})).await.unwrap_err();
        assert_eq!(unknown.kind, ErrorKind::Server);
        let bad = call(&imap, key, "list", json!({"limit": "ten"}))
            .await
            .unwrap_err();
        assert!(bad.message.starts_with("Bad request"), "{bad:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
