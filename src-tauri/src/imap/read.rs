//! Finding messages by id, and reading them whole: `message`, and the bytes
//! of `imap_bytes` (the original, or one part decoded); and the background
//! check's question (Android): unread Inbox mail since the last check.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::error::MailServerError;
use super::folders::{self, FolderTree};
use super::ids::{self, Location, Scheme};
use super::list;
use super::model::{BytesRequest, Message, Role};
use super::parse::{self, HeaderInfo, Meta};
use super::proto::{self, Command};
use super::session::{Access, ImapSession, Transport};
use super::state::Account;

/// The search key that finds a message by the server's id, if it has one.
fn server_key(id: &str) -> Option<String> {
    if let Some(email_id) = id.strip_prefix("e:") {
        let valid = !email_id.is_empty()
            && email_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        return valid.then(|| format!("EMAILID {email_id}"));
    }
    let msgid: u64 = id.strip_prefix("g:")?.parse().ok()?;
    Some(format!("X-GM-MSGID {msgid}"))
}

/// Where message `id` is: as last seen, else where an `l:` id says, else
/// found by the server's id (Gmail: in All Mail; else folder by folder).
pub async fn find<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    tree: &FolderTree,
    id: &str,
) -> Result<Option<Location>, MailServerError> {
    if let Some(location) = account.ids().get(id).cloned() {
        return Ok(Some(location));
    }
    if let Some(location) = ids::parse_local(id) {
        return Ok(Some(location));
    }
    let Some(key) = server_key(id) else {
        return Ok(None);
    };
    let folders: Vec<_> = match tree.role(Role::All) {
        Some(all) if id.starts_with("g:") => vec![all],
        _ => tree
            .folders
            .iter()
            .filter(|folder| folder.selectable && !folder.aggregate)
            .collect(),
    };
    for folder in folders {
        let selected = session.open_folder(&folder.raw, Access::ReadOnly).await?;
        let validity = selected.mailbox.uid_validity.unwrap_or_default();
        let found = proto::search(session, &Command::new(format!("UID SEARCH {key}"))).await?;
        if let Some(uid) = found.ok().and_then(|uids| uids.into_iter().max()) {
            let location = Location {
                path: folder.path.clone(),
                validity,
                uid,
            };
            account.ids().put(id, location.clone());
            return Ok(Some(location));
        }
    }
    Ok(None)
}

/// Messages in one folder: their ids and UIDs.
#[derive(Debug, PartialEq, Eq)]
pub struct Group {
    pub path: String,
    pub validity: u32,
    pub members: Vec<(String, u32)>,
}

/// Messages by folder. Ids that can't be found are left out (they're gone
/// already).
pub async fn locate<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    tree: &FolderTree,
    ids: &[String],
) -> Result<Vec<Group>, MailServerError> {
    let mut groups: Vec<Group> = Vec::new();
    for id in ids {
        let Some(location) = find(session, account, tree, id).await? else {
            continue;
        };
        let member = (id.clone(), location.uid);
        match groups
            .iter_mut()
            .find(|group| group.path == location.path && group.validity == location.validity)
        {
            Some(group) => group.members.push(member),
            None => groups.push(Group {
                path: location.path,
                validity: location.validity,
                members: vec![member],
            }),
        }
    }
    Ok(groups)
}

/// Opens a group's folder; false if its UIDVALIDITY changed since (its UIDs
/// mean other messages now).
pub async fn open_group<S: Transport>(
    session: &mut ImapSession<S>,
    tree: &FolderTree,
    path: &str,
    validity: u32,
    access: Access,
) -> Result<bool, MailServerError> {
    let selected = session.open_folder(&tree.raw(path), access).await?;
    let now = selected.mailbox.uid_validity.unwrap_or_default();
    Ok(validity == 0 || now == validity)
}

/// A whole message: its bytes (cached) and its row.
pub struct Fetched {
    pub raw: Arc<Vec<u8>>,
    pub meta: Meta,
}

/// Fetches message `id` whole (its bytes from the cache if they're there).
/// A message that's no longer where it was is looked for once more.
pub async fn fetch_message<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    id: &str,
) -> Result<Fetched, MailServerError> {
    let scheme = Scheme::of(&session.capabilities);
    let tree = folders::tree(session, account).await?;
    for _ in 0..2 {
        let Some(location) = find(session, account, &tree, id).await? else {
            break;
        };
        if !open_group(
            session,
            &tree,
            &location.path,
            location.validity,
            Access::ReadOnly,
        )
        .await?
        {
            account.ids().remove(id);
            continue;
        }
        let cached = account.cached(id);
        let items = format!(
            "UID FLAGS INTERNALDATE{}{}",
            if cached.is_none() { " BODY.PEEK[]" } else { "" },
            scheme.fetch_items()
        );
        let mut rows = list::fetch(session, &[location.uid], &items).await?;
        let Some(row) = rows.remove(&location.uid).filter(|row| !row.deleted) else {
            account.ids().remove(id);
            continue;
        };
        let raw = match cached {
            Some(raw) => raw,
            None => {
                let raw = Arc::new(row.body.clone().unwrap_or_default());
                account.cache(id, raw.clone());
                raw
            }
        };
        return Ok(Fetched {
            raw,
            meta: Meta {
                id: id.to_string(),
                folder: location.path,
                seen: row.seen,
                flagged: row.flagged,
                draft: row.draft,
                date: row.date,
                server: row.server,
            },
        });
    }
    Err(MailServerError::not_found("The message is gone."))
}

/// `message`: a whole message, parsed.
pub async fn message<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    id: &str,
) -> Result<Message, MailServerError> {
    let fetched = fetch_message(session, account, id).await?;
    Ok(parse::message(&fetched.raw, &fetched.meta))
}

/// `imap_bytes`: a message as it is, or one part decoded. Messages opened
/// a moment ago come from the cache without asking the server.
pub async fn bytes<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &BytesRequest,
) -> Result<Vec<u8>, MailServerError> {
    let (BytesRequest::Raw { id } | BytesRequest::Part { id, .. }) = request;
    let cached = account.cached(id);
    let raw = match cached {
        Some(raw) => raw,
        None => fetch_message(session, account, id).await?.raw,
    };
    match request {
        BytesRequest::Raw { .. } => Ok(raw.to_vec()),
        BytesRequest::Part { part, .. } => parse::part(&raw, part)
            .ok_or_else(|| MailServerError::not_found("The message has no such part.")),
    }
}

/// Where the background check got to in the Inbox (kept in `background.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxMark {
    pub validity: u32,
    /// The highest UID seen.
    pub last: u32,
}

/// An unread message, as much as a notification needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unread {
    /// Its id, as the app knows it.
    pub id: String,
    /// The sender's name, else address.
    pub from: String,
    pub subject: String,
    /// INTERNALDATE, ms since 1970.
    pub received: i64,
}

/// Unread Inbox mail after `mark` (the newest `max`), and the new mark.
/// Without a mark, or after the Inbox's UIDVALIDITY changed, just the mark.
pub async fn new_unread<S: Transport>(
    session: &mut ImapSession<S>,
    mark: Option<InboxMark>,
    max: usize,
) -> Result<(Vec<Unread>, InboxMark), MailServerError> {
    let selected = session.open_folder("INBOX", Access::ReadOnly).await?;
    let validity = selected.mailbox.uid_validity.unwrap_or_default();
    let next = selected.mailbox.uid_next.unwrap_or(1);
    let Some(mark) = mark.filter(|mark| mark.validity == validity) else {
        return Ok((
            Vec::new(),
            InboxMark {
                validity,
                last: next.saturating_sub(1),
            },
        ));
    };
    let command = Command::new(format!("UID SEARCH UNSEEN UID {}:*", mark.last + 1));
    let mut uids: Vec<u32> = proto::search(session, &command)
        .await?
        .map_err(|refused| refused.error)?
        .into_iter()
        .filter(|uid| *uid > mark.last)
        .collect();
    uids.sort_unstable();
    let last = uids
        .last()
        .copied()
        .unwrap_or(mark.last)
        .max(next.saturating_sub(1))
        .max(mark.last);
    let newest = &uids[uids.len().saturating_sub(max)..];
    if newest.is_empty() {
        return Ok((Vec::new(), InboxMark { validity, last }));
    }
    let scheme = Scheme::of(&session.capabilities);
    let items = format!(
        "UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]{}",
        scheme.fetch_items()
    );
    let rows = list::fetch(session, newest, &items).await?;
    let mut found: Vec<Unread> = rows
        .into_values()
        .map(|row| {
            let info = HeaderInfo::read(&row.header);
            let location = Location {
                path: "INBOX".into(),
                validity,
                uid: row.uid,
            };
            Unread {
                id: row
                    .server
                    .message_id()
                    .unwrap_or_else(|| ids::local_id(&location)),
                from: info
                    .from
                    .map(|from| from.name.unwrap_or(from.address))
                    .unwrap_or_default(),
                subject: info.subject,
                received: row.date,
            }
        })
        .collect();
    found.sort_by_key(|unread| unread.received);
    Ok((found, InboxMark { validity, last }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::testing::logged_in;

    const LIST: &str = "
        C: A0003 LIST \"\" \"*\"
        S: * LIST (\\HasNoChildren) \"/\" INBOX
        S: * LIST (\\HasNoChildren) \"/\" Archive
        S: A0003 OK done
    ";

    #[tokio::test]
    async fn fetches_a_message_once_and_its_parts_from_the_cache() {
        let raw = "Subject: Hi\r\nMessage-ID: <a@x>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHello\r\n--b\r\nContent-Type: text/plain; name=n.txt\r\nContent-Disposition: attachment\r\n\r\nfile\r\n--b--\r\n";
        let script = format!(
            "{LIST}
            C: A0004 EXAMINE \"INBOX\"
            S: * 1 EXISTS
            S: * OK [UIDVALIDITY 3] ok
            S: A0004 OK done
            C: A0005 UID SEARCH EMAILID M77
            S: * SEARCH
            S: A0005 OK done
            C: A0006 EXAMINE \"Archive\"
            S: * 1 EXISTS
            S: * OK [UIDVALIDITY 4] ok
            S: A0006 OK done
            C: A0007 UID SEARCH EMAILID M77
            S: * SEARCH 8
            S: A0007 OK done
            C: A0008 UID FETCH 8 (UID FLAGS INTERNALDATE BODY.PEEK[] EMAILID THREADID)
            S: * 1 FETCH (UID 8 FLAGS (\\Draft) INTERNALDATE \"01-Oct-2026 10:00:00 +0000\" EMAILID (M77) THREADID (T5) BODY[] {{{}}}
            {}
            S: )
            S: A0008 OK done
            ",
            raw.len(),
            raw.split_inclusive("\r\n")
                .map(|line| format!("S: {}", line.trim_end_matches("\r\n")))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let (mut session, server) = logged_in("IMAP4rev1 OBJECTID", &script).await;
        let account = Account::default();
        let message = message(&mut session, &account, "e:M77").await.unwrap();
        assert_eq!(message.summary.subject, "Hi");
        assert_eq!(message.summary.thread_id, "t:T5");
        assert_eq!(message.summary.mailbox_ids, ["f:Archive"]);
        assert!(message.draft);
        assert_eq!(message.attachments[0].id, "2");
        let file = bytes(
            &mut session,
            &account,
            &BytesRequest::Part {
                id: "e:M77".into(),
                part: "2".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(file, b"file");
        let original = bytes(
            &mut session,
            &account,
            &BytesRequest::Raw { id: "e:M77".into() },
        )
        .await
        .unwrap();
        assert_eq!(original, raw.as_bytes());
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_local_id_thats_gone_is_not_found() {
        let script = format!(
            "{LIST}
            C: A0004 EXAMINE \"INBOX\"
            S: * 1 EXISTS
            S: * OK [UIDVALIDITY 3] ok
            S: A0004 OK done
            C: A0005 UID FETCH 8 (UID FLAGS INTERNALDATE BODY.PEEK[])
            S: A0005 OK done
            C: A0006 UID FETCH 8 (UID FLAGS INTERNALDATE BODY.PEEK[])
            S: A0006 OK done
            "
        );
        let (mut session, server) = logged_in("IMAP4rev1", &script).await;
        let error = message(&mut session, &Account::default(), "l:f:INBOX:3:8")
            .await
            .unwrap_err();
        server.await.unwrap().unwrap();
        assert_eq!(error.kind, crate::imap::ErrorKind::NotFound);
    }
}
