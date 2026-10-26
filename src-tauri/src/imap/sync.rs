//! What changed since the last check (`changes`).
//!
//! The token is base64 JSON of each folder's state at the check: UIDVALIDITY,
//! UIDNEXT, HIGHESTMODSEQ (CONDSTORE), MESSAGES and UNSEEN. A check asks
//! STATUS for every folder (in the LIST where the server has LIST-STATUS) and
//! looks into those whose state changed:
//!
//! - new mail: the UIDs from the old UIDNEXT on (`added`);
//! - with QRESYNC: `UID FETCH … (CHANGEDSINCE <modseq> VANISHED)` gives the
//!   flag changes (`updated`) and the expunged UIDs (`removed`);
//! - with CONDSTORE only: CHANGEDSINCE gives the flag changes, and expunged
//!   messages are found by comparing the newest 200 UIDs with the last check;
//! - else the newest 200 UIDs and their flags are compared with the last
//!   check (kept in memory per account; the Inbox's always, so its flag
//!   changes show even when its counts didn't change).
//!
//! A message that moved is `updated` with its new folder where its id is
//! known (removed here, added there). A changed UIDVALIDITY, folders that
//! came or went, more than 200 changes, changes that can't be told apart
//! (no memory of the folder yet), or an unreadable token mean `reset`.

use std::collections::{BTreeMap, HashMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use super::error::MailServerError;
use super::folders::{self, FolderTree};
use super::ids::{self, Location, Scheme};
use super::list::{self, Row, SnapFolder};
use super::model::{Change, Changes, ChangesRequest, Summary};
use super::proto::{self, Command};
use super::session::{Access, ImapSession, Transport};
use super::state::Account;
use async_imap::imap_proto::Response;

/// More changes than this make the UI load everything again.
const MAX_CHANGES: usize = 200;
/// How many of a folder's newest messages are compared without CONDSTORE.
const WINDOW: u32 = 200;

/// A folder's state in the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FolderState {
    #[serde(rename = "v")]
    validity: u32,
    #[serde(rename = "n")]
    uid_next: u32,
    #[serde(rename = "m", default, skip_serializing_if = "Option::is_none")]
    modseq: Option<u64>,
    #[serde(rename = "c")]
    messages: u32,
    #[serde(rename = "u")]
    unseen: u32,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Token {
    #[serde(rename = "f")]
    folders: BTreeMap<String, FolderState>,
}

fn encode(token: &Token) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(token).expect("a token serializes"))
}

fn decode(text: &str) -> Option<Token> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(text).ok()?).ok()
}

/// The newest messages of a folder and their flags (seen, flagged), as the
/// last check saw them.
#[derive(Clone, Debug, Default)]
struct Window {
    validity: u32,
    flags: BTreeMap<u32, (bool, bool)>,
}

/// What the last checks saw, per folder (no CONDSTORE/QRESYNC to ask).
#[derive(Debug, Default)]
pub struct SyncMemory {
    windows: HashMap<String, Window>,
}

/// The changes found so far.
#[derive(Default)]
struct Found {
    added: Vec<Summary>,
    updated: Vec<Summary>,
    removed: Vec<String>,
}

impl Found {
    fn len(&self) -> usize {
        self.added.len() + self.updated.len() + self.removed.len()
    }

    /// The changes, a message both removed and added (it moved) as `updated`.
    fn changes(self) -> Vec<Change> {
        let removed: HashSet<&str> = self.removed.iter().map(String::as_str).collect();
        let added: HashSet<&str> = self.added.iter().map(|s| s.id.as_str()).collect();
        let mut changes = Vec::new();
        let mut done: HashSet<String> = HashSet::new();
        for id in &self.removed {
            if !added.contains(id.as_str()) && done.insert(id.clone()) {
                changes.push(Change::Removed { id: id.clone() });
            }
        }
        for summary in self.added {
            if !done.insert(summary.id.clone()) {
                continue;
            }
            changes.push(if removed.contains(summary.id.as_str()) {
                Change::Updated { message: summary }
            } else {
                Change::Added { message: summary }
            });
        }
        for summary in self.updated {
            if done.insert(summary.id.clone()) {
                changes.push(Change::Updated { message: summary });
            }
        }
        changes
    }
}

/// `changes`: what changed since `token`; without one, just the token.
pub async fn changes<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &ChangesRequest,
    rich: bool,
) -> Result<Changes, MailServerError> {
    let condstore = session.capabilities.has("CONDSTORE");
    let qresync = session.enabled.has("QRESYNC");
    let items = if condstore {
        "MESSAGES UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ"
    } else {
        "MESSAGES UIDNEXT UIDVALIDITY UNSEEN"
    };
    let tree = folders::fresh_tree(session, account, Some(items)).await?;
    let now: BTreeMap<String, FolderState> = tree
        .folders
        .iter()
        .filter(|folder| folder.selectable && !folder.aggregate)
        .filter_map(|folder| {
            let status = folder.status?;
            Some((
                folder.path.clone(),
                FolderState {
                    validity: status.uid_validity?,
                    uid_next: status.uid_next?,
                    modseq: status.highest_modseq,
                    messages: status.messages.unwrap_or_default(),
                    unseen: status.unseen.unwrap_or_default(),
                },
            ))
        })
        .collect();
    let token = encode(&Token {
        folders: now.clone(),
    });
    let reset = |token: String| Changes {
        token,
        reset: true,
        changes: Vec::new(),
    };
    let Some(before) = request.token.as_deref() else {
        if !qresync && let Some(inbox) = now.get("INBOX") {
            remember(session, account, &tree, "INBOX", inbox.validity).await?;
        }
        return Ok(Changes {
            token,
            reset: false,
            changes: Vec::new(),
        });
    };
    let Some(before) = decode(before) else {
        return Ok(reset(token));
    };
    let came_or_went = before.folders.keys().any(|path| !now.contains_key(path))
        || now
            .iter()
            .any(|(path, state)| !before.folders.contains_key(path) && state.messages > 0);
    if came_or_went {
        return Ok(reset(token));
    }
    let mut found = Found::default();
    for (path, state) in &now {
        let Some(old) = before.folders.get(path) else {
            continue;
        };
        if old.validity != state.validity {
            return Ok(reset(token));
        }
        let always = !condstore && path == "INBOX";
        if old == state && !always {
            continue;
        }
        let complete = check_folder(
            session,
            account,
            &tree,
            path,
            (old, state),
            (condstore, qresync),
            rich,
            &mut found,
        )
        .await?;
        if !complete || found.len() > MAX_CHANGES {
            return Ok(reset(token));
        }
    }
    Ok(Changes {
        token,
        reset: false,
        changes: found.changes(),
    })
}

/// Notes a folder's newest messages and flags, for the next check.
async fn remember<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    tree: &FolderTree,
    path: &str,
    validity: u32,
) -> Result<(), MailServerError> {
    let selected = session
        .reopen_folder(&tree.raw(path), Access::ReadOnly)
        .await?;
    let exists = selected.mailbox.exists;
    let window = window(session, exists).await?;
    account.sync.lock().expect("imap lock").windows.insert(
        path.to_string(),
        Window {
            validity,
            flags: window
                .iter()
                .filter(|(_, row)| !row.deleted)
                .map(|(uid, row)| (*uid, (row.seen, row.flagged)))
                .collect(),
        },
    );
    Ok(())
}

/// The newest [`WINDOW`] messages of the open folder (which has `exists`).
async fn window<S: Transport>(
    session: &mut ImapSession<S>,
    exists: u32,
) -> Result<BTreeMap<u32, Row>, MailServerError> {
    let mut rows = BTreeMap::new();
    if exists == 0 {
        return Ok(rows);
    }
    let first = exists.saturating_sub(WINDOW - 1).max(1);
    let command = Command::new(format!("FETCH {first}:* (UID FLAGS)"));
    proto::run(session, &command, |response| {
        if let Response::Fetch(_, attributes) = response
            && let Some(row) = Row::read(attributes)
        {
            rows.insert(row.uid, row);
        }
    })
    .await?;
    Ok(rows)
}

/// Looks into one folder whose state changed; false if what changed can't
/// be told (the caller resets).
#[allow(clippy::too_many_arguments)]
async fn check_folder<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    tree: &FolderTree,
    path: &str,
    (old, now): (&FolderState, &FolderState),
    (condstore, qresync): (bool, bool),
    rich: bool,
    found: &mut Found,
) -> Result<bool, MailServerError> {
    let raw = tree.raw(path);
    let selected = session.reopen_folder(&raw, Access::ReadOnly).await?;
    let validity = selected.mailbox.uid_validity.unwrap_or_default();
    let exists = selected.mailbox.exists;
    if validity != now.validity {
        return Ok(false);
    }
    let folder = SnapFolder {
        path: path.to_string(),
        raw,
        validity,
    };
    let scheme = Scheme::of(&session.capabilities);

    // New mail.
    let mut new_uids = Vec::new();
    let mut new_unseen = 0;
    if now.uid_next > old.uid_next {
        let rows =
            list::fetch_set(session, &format!("{}:*", old.uid_next), "UID FLAGS", "").await?;
        for row in rows.values() {
            if row.uid < old.uid_next || row.uid >= now.uid_next {
                continue;
            }
            new_uids.push(row.uid);
            if !row.seen {
                new_unseen += 1;
            }
        }
        new_uids.sort_unstable();
        let summaries = list::summaries(session, account, &folder, &new_uids, rich).await?;
        found.added.extend(
            new_uids
                .iter()
                .filter_map(|uid| summaries.get(uid).cloned()),
        );
    }

    let mut changed: Vec<u32> = Vec::new();
    let mut gone: Vec<u32> = Vec::new();
    let modseq = old.modseq.filter(|_| condstore);
    if let Some(modseq) = modseq
        && old.uid_next > 1
        && now.modseq != old.modseq
    {
        let extra = if qresync {
            format!(" (CHANGEDSINCE {modseq} VANISHED)")
        } else {
            format!(" (CHANGEDSINCE {modseq})")
        };
        let rows = list::fetch_set(
            session,
            &format!("1:{}", old.uid_next - 1),
            "UID FLAGS",
            &extra,
        )
        .await?;
        for row in rows.values().filter(|row| row.uid < old.uid_next) {
            if row.deleted {
                gone.push(row.uid);
            } else {
                changed.push(row.uid);
            }
        }
    }

    if !(qresync && modseq.is_some()) {
        // Compare the newest messages with the last check.
        let current = window(session, exists).await?;
        let memory = account
            .sync
            .lock()
            .expect("imap lock")
            .windows
            .get(path)
            .filter(|window| window.validity == validity)
            .cloned();
        let lowest = current.keys().next().copied().unwrap_or(u32::MAX);
        let expected_gone = (old.messages + new_uids.len() as u32).saturating_sub(exists);
        match &memory {
            Some(memory) => {
                for (uid, (seen, flagged)) in memory.flags.range(..old.uid_next) {
                    match current.get(uid) {
                        None if *uid >= lowest || current.is_empty() => gone.push(*uid),
                        Some(row) if row.deleted => gone.push(*uid),
                        Some(row)
                            if modseq.is_none() && (row.seen, row.flagged) != (*seen, *flagged) =>
                        {
                            changed.push(*uid)
                        }
                        _ => {}
                    }
                }
                gone.sort_unstable();
                gone.dedup();
                if (gone.len() as u32) < expected_gone {
                    return Ok(false);
                }
            }
            None => {
                let unseen_moved = now.unseen != old.unseen + new_unseen;
                if expected_gone > 0 || (modseq.is_none() && unseen_moved) {
                    return Ok(false);
                }
            }
        }
        account.sync.lock().expect("imap lock").windows.insert(
            path.to_string(),
            Window {
                validity,
                flags: current
                    .iter()
                    .filter(|(_, row)| !row.deleted)
                    .map(|(uid, row)| (*uid, (row.seen, row.flagged)))
                    .collect(),
            },
        );
    }

    // Removed: by the id they had, where it's known (or derivable).
    {
        let mut ids = account.ids();
        for uid in &gone {
            let location = Location {
                path: path.to_string(),
                validity,
                uid: *uid,
            };
            let id = ids
                .known_at(&location)
                .map(str::to_string)
                .or_else(|| (scheme == Scheme::Local).then(|| ids::local_id(&location)));
            if let Some(id) = id {
                if ids.get(&id) == Some(&location) {
                    ids.remove(&id);
                }
                found.removed.push(id);
            }
        }
    }

    changed.sort_unstable();
    changed.dedup();
    changed.retain(|uid| !gone.contains(uid));
    if found.len() + changed.len() > MAX_CHANGES {
        return Ok(false);
    }
    if !changed.is_empty() {
        let summaries = list::summaries(session, account, &folder, &changed, rich).await?;
        found
            .updated
            .extend(changed.iter().filter_map(|uid| summaries.get(uid).cloned()));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::list::HEADER_FIELDS;
    use crate::imap::model::Change;
    use crate::imap::session::Capabilities;
    use crate::imap::testing::logged_in;

    fn token(folders: &[(&str, FolderState)]) -> String {
        encode(&Token {
            folders: folders
                .iter()
                .map(|(path, state)| (path.to_string(), *state))
                .collect(),
        })
    }

    fn state(
        validity: u32,
        uid_next: u32,
        modseq: Option<u64>,
        messages: u32,
        unseen: u32,
    ) -> FolderState {
        FolderState {
            validity,
            uid_next,
            modseq,
            messages,
            unseen,
        }
    }

    fn header_row(seq: u32, uid: u32, flags: &str) -> String {
        format!(
            "S: * {seq} FETCH (UID {uid} FLAGS ({flags}) INTERNALDATE \"01-Oct-2026 10:00:00 +0000\" BODY[HEADER.FIELDS (SUBJECT)] {{2}}\nS:\nS: )"
        )
    }

    #[tokio::test]
    async fn finds_new_mail_flag_changes_and_vanished_with_qresync() {
        let before = token(&[
            ("INBOX", state(5, 10, Some(100), 3, 1)),
            ("Archive", state(6, 4, Some(50), 3, 0)),
        ]);
        let rest = format!(
            "
            C: A0003 LIST \"\" \"*\" RETURN (STATUS (MESSAGES UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ))
            S: * LIST () \"/\" INBOX
            S: * STATUS INBOX (MESSAGES 3 UIDNEXT 11 UIDVALIDITY 5 UNSEEN 2 HIGHESTMODSEQ 120)
            S: * LIST () \"/\" Archive
            S: * STATUS Archive (MESSAGES 3 UIDNEXT 4 UIDVALIDITY 6 UNSEEN 0 HIGHESTMODSEQ 50)
            S: A0003 OK done
            C: A0004 EXAMINE \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 5] ok
            S: A0004 OK done
            C: A0005 UID FETCH 10:* (UID FLAGS)
            S: * 3 FETCH (UID 10 FLAGS ())
            S: A0005 OK done
            C: A0006 UID FETCH 10 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0006 OK done
            C: A0007 UID FETCH 10 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0007 OK done
            C: A0008 UID FETCH 1:9 (UID FLAGS) (CHANGEDSINCE 100 VANISHED)
            S: * VANISHED (EARLIER) 7
            S: * 2 FETCH (UID 8 FLAGS (\\Seen) MODSEQ (119))
            S: A0008 OK done
            C: A0009 UID FETCH 8 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0009 OK done
            C: A0010 UID FETCH 8 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0010 OK done
            ",
            header_row(3, 10, ""),
            header_row(2, 8, "\\Seen"),
        );
        let (mut session, server) = logged_in(
            "IMAP4rev1 LIST-EXTENDED LIST-STATUS CONDSTORE QRESYNC",
            &rest,
        )
        .await;
        session.enabled = Capabilities::from_iter(["CONDSTORE", "QRESYNC"]);
        let account = Account::default();
        let answer = changes(
            &mut session,
            &account,
            &ChangesRequest {
                token: Some(before),
            },
            false,
        )
        .await
        .unwrap();
        server.await.unwrap().unwrap();
        assert!(!answer.reset);
        let kinds: Vec<(String, String)> = answer
            .changes
            .iter()
            .map(|change| match change {
                Change::Added { message } => ("added".into(), message.id.clone()),
                Change::Updated { message } => ("updated".into(), message.id.clone()),
                Change::Removed { id } => ("removed".into(), id.clone()),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("removed".into(), "l:f:INBOX:5:7".into()),
                ("added".into(), "l:f:INBOX:5:10".into()),
                ("updated".into(), "l:f:INBOX:5:8".into()),
            ]
        );
        let next = decode(&answer.token).unwrap();
        assert_eq!(next.folders["INBOX"].uid_next, 11);
        assert_eq!(next.folders["INBOX"].modseq, Some(120));
    }

    #[tokio::test]
    async fn compares_the_newest_messages_without_condstore() {
        let rest = format!(
            "
            C: A0003 LIST \"\" \"*\"
            S: * LIST () \"/\" INBOX
            S: A0003 OK done
            C: A0004 STATUS \"INBOX\" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)
            S: * STATUS INBOX (MESSAGES 3 UIDNEXT 4 UIDVALIDITY 5 UNSEEN 3)
            S: A0004 OK done
            C: A0005 EXAMINE \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 5] ok
            S: A0005 OK done
            C: A0006 FETCH 1:* (UID FLAGS)
            S: * 1 FETCH (UID 1 FLAGS ())
            S: * 2 FETCH (UID 2 FLAGS ())
            S: * 3 FETCH (UID 3 FLAGS ())
            S: A0006 OK done
            C: A0007 LIST \"\" \"*\"
            S: * LIST () \"/\" INBOX
            S: A0007 OK done
            C: A0008 STATUS \"INBOX\" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)
            S: * STATUS INBOX (MESSAGES 2 UIDNEXT 4 UIDVALIDITY 5 UNSEEN 1)
            S: A0008 OK done
            C: A0009 EXAMINE \"INBOX\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 5] ok
            S: A0009 OK done
            C: A0010 FETCH 1:* (UID FLAGS)
            S: * 1 FETCH (UID 1 FLAGS (\\Flagged))
            S: * 2 FETCH (UID 3 FLAGS (\\Seen \\Flagged))
            S: A0010 OK done
            C: A0011 UID FETCH 1,3 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            {}
            S: A0011 OK done
            C: A0012 UID FETCH 1,3 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0012 OK done
            C: A0013 LIST \"\" \"*\"
            S: * LIST () \"/\" INBOX
            S: A0013 OK done
            C: A0014 STATUS \"INBOX\" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)
            S: * STATUS INBOX (MESSAGES 2 UIDNEXT 4 UIDVALIDITY 9 UNSEEN 1)
            S: A0014 OK done
            ",
            header_row(1, 1, "\\Flagged"),
            header_row(2, 3, "\\Seen \\Flagged"),
        );
        let (mut session, server) = logged_in("IMAP4rev1", &rest).await;
        let account = Account::default();
        let first = changes(&mut session, &account, &ChangesRequest::default(), true)
            .await
            .unwrap();
        assert!(first.changes.is_empty() && !first.reset);
        let second = changes(
            &mut session,
            &account,
            &ChangesRequest {
                token: Some(first.token),
            },
            false,
        )
        .await
        .unwrap();
        assert!(!second.reset);
        let ids: Vec<String> = second
            .changes
            .iter()
            .map(|change| match change {
                Change::Removed { id } => format!("-{id}"),
                Change::Updated { message } => format!("~{}", message.id),
                Change::Added { message } => format!("+{}", message.id),
            })
            .collect();
        assert_eq!(ids, ["-l:f:INBOX:5:2", "~l:f:INBOX:5:1", "~l:f:INBOX:5:3"]);
        // UIDVALIDITY changed: start over.
        let third = changes(
            &mut session,
            &account,
            &ChangesRequest {
                token: Some(second.token),
            },
            false,
        )
        .await
        .unwrap();
        server.await.unwrap().unwrap();
        assert!(third.reset);
        // And an unreadable token too.
        assert_eq!(decode("not a token"), None);
    }

    #[test]
    fn a_message_removed_here_and_added_there_moved() {
        let summary = |id: &str, folder: &str| Summary {
            id: id.into(),
            thread_id: "t".into(),
            mailbox_ids: vec![folder.into()],
            from: None,
            to: Vec::new(),
            subject: String::new(),
            snippet: String::new(),
            received_at: String::new(),
            flags: Default::default(),
            has_attachments: false,
        };
        let found = Found {
            added: vec![summary("e:1", "f:Archive"), summary("e:2", "f:INBOX")],
            updated: vec![summary("e:2", "f:INBOX"), summary("e:3", "f:INBOX")],
            removed: vec!["e:1".into(), "e:4".into()],
        };
        let changes = found.changes();
        assert_eq!(changes.len(), 4);
        assert!(matches!(&changes[0], Change::Removed { id } if id == "e:4"));
        assert!(
            matches!(&changes[1], Change::Updated { message } if message.id == "e:1" && message.mailbox_ids == ["f:Archive"])
        );
        assert!(matches!(&changes[2], Change::Added { message } if message.id == "e:2"));
        assert!(matches!(&changes[3], Change::Updated { message } if message.id == "e:3"));
    }
}
