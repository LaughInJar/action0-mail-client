//! Conversations. A message's thread key is the server's thread id
//! (THREADID, X-GM-THRID), else the first Message-ID of its References
//! (else In-Reply-To, else its own Message-ID): see `parse::thread_key`.
//!
//! `threads` pages through the same snapshots as `list` and groups each
//! page's rows by thread; a conversation shows on the page of its first
//! (newest) message, and its messages further down are left out of later
//! pages. `thread` finds a conversation's messages in the Inbox, Sent,
//! Archive and the folder it was listed in, and reads them whole.

use std::collections::HashSet;
use std::sync::Arc;

use super::error::MailServerError;
use super::folders;
use super::ids::Scheme;
use super::list::{self, Row};
use super::model::{ListQuery, Message, Page, Role, Thread};
use super::parse::{self, Meta};
use super::proto::{self, Command};
use super::read;
use super::session::{Access, ImapSession, Transport};
use super::state::Account;

/// The most messages of one conversation read per folder (the newest).
const MAX_THREAD: usize = 100;

/// `threads`: a page of a folder's or view's conversations.
pub async fn threads<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &ListQuery,
    rich: bool,
) -> Result<Page<Thread>, MailServerError> {
    let (snapshot, id, offset) = list::snapshot_for(session, account, request, "threads").await?;
    let limit = list::limit_of(request);
    let total = snapshot.entries.len();
    let mut threads: Vec<Thread> = Vec::new();
    let mut position = offset.min(total);
    let mut next: Option<usize> = None;
    while next.is_none() && position < total {
        let end = (position + limit).min(total);
        let batch = &snapshot.entries[position..end];
        let summaries = list::page_summaries(session, account, &snapshot, batch, rich).await?;
        let mut first_seen = snapshot.first_seen.lock().expect("imap lock");
        for (index, summary) in (position..end).zip(summaries) {
            let Some(summary) = summary else {
                continue;
            };
            let key = summary.thread_id.clone();
            let seen_at = first_seen.get(&key).copied();
            if let Some(thread) = threads.iter_mut().find(|thread| thread.id == key) {
                thread.messages.push(summary);
                continue;
            }
            match seen_at {
                // Shown on an earlier page.
                Some(at) if at < offset => {}
                _ if threads.len() < limit => {
                    let at = first_seen.entry(key.clone()).or_insert(index);
                    *at = (*at).min(index);
                    threads.push(Thread {
                        id: key,
                        messages: vec![summary],
                    });
                }
                _ => {
                    next.get_or_insert(index);
                }
            }
        }
        position = end;
    }
    let next = next.or((position < total).then_some(position));
    for thread in &mut threads {
        thread
            .messages
            .sort_by(|a, b| a.received_at.cmp(&b.received_at));
        if let Some(folder) = thread
            .messages
            .last()
            .and_then(|newest| newest.mailbox_ids.first())
            .and_then(|folder| folder.strip_prefix("f:"))
        {
            account.note_listed(&thread.id, folder);
        }
    }
    Ok(Page {
        items: threads,
        next_cursor: next.map(|at| list::cursor(&id, at)),
    })
}

/// The search for a thread key's messages, and whether its results must be
/// checked to have that key (a Message-ID root finds a little more).
fn thread_search(id: &str) -> Option<(Command, bool)> {
    if let Some(thread) = id.strip_prefix("t:") {
        let valid = !thread.is_empty()
            && thread
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        return valid.then(|| {
            (
                Command::new(format!("UID SEARCH UNDELETED THREADID {thread}")),
                false,
            )
        });
    }
    if let Some(thread) = id.strip_prefix("g:") {
        let thread: u64 = thread.parse().ok()?;
        return Some((
            Command::new(format!("UID SEARCH UNDELETED X-GM-THRID {thread}")),
            false,
        ));
    }
    if id.starts_with('<') {
        let command = Command::new("UID SEARCH UNDELETED OR OR HEADER Message-ID ")
            .string(id)
            .text(" HEADER References ")
            .string(id)
            .text(" HEADER In-Reply-To ")
            .string(id);
        return Some((command, true));
    }
    None
}

/// `thread`: a conversation's messages, whole, oldest first.
pub async fn thread<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    id: &str,
) -> Result<Vec<Message>, MailServerError> {
    if let Some(message) = id.strip_prefix("m:") {
        return Ok(vec![read::message(session, account, message).await?]);
    }
    let Some((search, check)) = thread_search(id) else {
        return Err(MailServerError::not_found("The conversation is gone."));
    };
    let scheme = Scheme::of(&session.capabilities);
    let tree = folders::tree(session, account).await?;
    let mut paths: Vec<String> = [Role::Inbox, Role::Sent, Role::Archive]
        .into_iter()
        .filter_map(|role| tree.role(role).map(|folder| folder.path.clone()))
        .collect();
    if let Some(listed) = account.listed_in(id)
        && !paths.contains(&listed)
    {
        paths.push(listed);
    }
    let mut found: Vec<(i64, Message)> = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let Some(folder) = tree.get(&path).filter(|folder| folder.selectable) else {
            continue;
        };
        let selected = session.open_folder(&folder.raw, Access::ReadOnly).await?;
        let validity = selected.mailbox.uid_validity.unwrap_or_default();
        // A server that doesn't know the search key has none of it there.
        let Ok(mut uids) = proto::search(session, &search).await? else {
            continue;
        };
        uids.sort_unstable();
        let uids = &uids[uids.len().saturating_sub(MAX_THREAD)..];
        if uids.is_empty() {
            continue;
        }
        let rows = list::fetch(
            session,
            uids,
            &format!("UID FLAGS INTERNALDATE{}", scheme.fetch_items()),
        )
        .await?;
        let mut rows: Vec<Row> = rows.into_values().filter(|row| !row.deleted).collect();
        rows.sort_by_key(|row| row.uid);
        let mut members = Vec::new();
        let mut missing = Vec::new();
        for row in rows {
            let message_id = account
                .ids()
                .identify(&row.location(&path, validity), &row.server);
            // The same message in two folders (Gmail's labels) counts once.
            if !seen.insert(message_id.clone()) {
                continue;
            }
            if account.cached(&message_id).is_none() {
                missing.push(row.uid);
            }
            members.push((message_id, row));
        }
        let mut bodies = if missing.is_empty() {
            Default::default()
        } else {
            list::fetch(session, &missing, "UID BODY.PEEK[]").await?
        };
        for (message_id, row) in members {
            let raw = match account.cached(&message_id) {
                Some(raw) => raw,
                None => {
                    let Some(body) = bodies.remove(&row.uid).and_then(|fetched| fetched.body)
                    else {
                        continue;
                    };
                    let raw = Arc::new(body);
                    account.cache(&message_id, raw.clone());
                    raw
                }
            };
            let message = parse::message(
                &raw,
                &Meta {
                    id: message_id,
                    folder: path.clone(),
                    seen: row.seen,
                    flagged: row.flagged,
                    draft: row.draft,
                    date: row.date,
                    server: row.server,
                },
            );
            if check && message.summary.thread_id != id {
                continue;
            }
            found.push((row.date, message));
        }
    }
    found.sort_by_key(|(date, _)| *date);
    Ok(found.into_iter().map(|(_, message)| message).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::list::HEADER_FIELDS;
    use crate::imap::testing::logged_in;

    fn row(seq: u32, uid: u32, date: &str, header: &str) -> String {
        format!(
            "S: * {seq} FETCH (UID {uid} FLAGS (\\Seen) INTERNALDATE \"{date} +0000\" BODY[HEADER.FIELDS (MESSAGE-ID REFERENCES)] {{{}}}\n{}\nS: )",
            header.len() + 4,
            header
                .split("\r\n")
                .map(|line| format!("S: {line}"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\nS:"
        )
    }

    /// A whole message as a scripted FETCH answer.
    fn whole(seq: u32, uid: u32, message: &str) -> String {
        let lines = message
            .trim_end_matches("\r\n")
            .split("\r\n")
            .map(|line| format!("S: {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "S: * {seq} FETCH (UID {uid} BODY[] {{{}}}\n{lines}\nS: )",
            message.len()
        )
    }

    #[tokio::test]
    async fn opens_a_conversation_whose_messages_arent_in_memory_yet() {
        let first = "Message-ID: <a1@x>\r\nSubject: Plans\r\n\r\nShall we?\r\n";
        let reply =
            "Message-ID: <a2@x>\r\nReferences: <a1@x>\r\nSubject: Re: Plans\r\n\r\nYes.\r\n";
        let rest = format!(
            "
            C: A0003 LIST \"\" \"*\"
            S: * LIST () \"/\" INBOX
            S: A0003 OK done
            C: A0004 EXAMINE \"INBOX\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK done
            C: A0005 UID SEARCH UNDELETED OR OR HEADER Message-ID \"<a1@x>\" HEADER References \"<a1@x>\" HEADER In-Reply-To \"<a1@x>\"
            S: * SEARCH 1 2
            S: A0005 OK done
            C: A0006 UID FETCH 1:2 (UID FLAGS INTERNALDATE)
            S: * 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE \"01-Oct-2026 10:00:00 +0000\")
            S: * 2 FETCH (UID 2 FLAGS () INTERNALDATE \"02-Oct-2026 10:00:00 +0000\")
            S: A0006 OK done
            C: A0007 UID FETCH 1:2 (UID BODY.PEEK[])
            {}
            {}
            S: A0007 OK done
            ",
            whole(1, 1, first),
            whole(2, 2, reply),
        );
        let (mut session, server) = logged_in("IMAP4rev1", &rest).await;
        let account = Account::default();
        // Putting the fetched messages into memory once deadlocked.
        let messages = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            thread(&mut session, &account, "<a1@x>"),
        )
        .await
        .expect("no deadlock")
        .unwrap();
        let subjects: Vec<&str> = messages
            .iter()
            .map(|message| message.summary.subject.as_str())
            .collect();
        assert_eq!(subjects, ["Plans", "Re: Plans"]);
        assert!(account.cached("l:f:INBOX:1:2").is_some());
        drop(session);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn groups_pages_by_thread_and_leaves_out_threads_shown_before() {
        // Newest first: 6 (thread A), 5 (B), 4 (A), 3 (C), 2 (B), 1 (D).
        let a = "Message-ID: <a1@x>";
        let rest = format!(
            "
            C: A0003 LIST \"\" \"*\"
            S: * LIST () \"/\" INBOX
            S: A0003 OK done
            C: A0004 EXAMINE \"INBOX\"
            S: * 6 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK done
            C: A0005 UID SEARCH UNDELETED
            S: * SEARCH 1 2 3 4 5 6
            S: A0005 OK done
            C: A0006 UID FETCH 5:6 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            {}
            S: A0006 OK done
            C: A0007 UID FETCH 5:6 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0007 OK done
            C: A0008 UID FETCH 3:4 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            {}
            S: A0008 OK done
            C: A0009 UID FETCH 3:4 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0009 OK done
            C: A0010 UID FETCH 2:3 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            {}
            S: A0010 OK done
            C: A0011 UID FETCH 2:3 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0011 OK done
            C: A0012 UID FETCH 1 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0012 OK done
            C: A0013 UID FETCH 1 (UID BODY.PEEK[TEXT]<0.2048>)
            S: A0013 OK done
            ",
            row(
                6,
                6,
                "06-Oct-2026 10:00:00",
                "Message-ID: <a2@x>\r\nReferences: <a1@x>"
            ),
            row(
                5,
                5,
                "05-Oct-2026 10:00:00",
                "Message-ID: <b2@x>\r\nReferences: <b1@x>"
            ),
            row(4, 4, "04-Oct-2026 10:00:00", a),
            row(3, 3, "03-Oct-2026 10:00:00", "Message-ID: <c1@x>"),
            row(3, 3, "03-Oct-2026 10:00:00", "Message-ID: <c1@x>"),
            row(2, 2, "02-Oct-2026 10:00:00", "Message-ID: <b1@x>"),
            row(1, 1, "01-Oct-2026 10:00:00", "Message-ID: <d1@x>"),
        );
        let (mut session, server) = logged_in("IMAP4rev1", &rest).await;
        let account = Account::default();
        let request = |cursor: Option<String>| ListQuery {
            mailbox_id: "f:INBOX".into(),
            search: None,
            order: None,
            cursor,
            limit: 2,
        };
        let first = threads(&mut session, &account, &request(None), false)
            .await
            .unwrap();
        let ids: Vec<&str> = first.items.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["<a1@x>", "<b1@x>"]);
        // A's older message was on the batch after: added to A, oldest first.
        assert_eq!(first.items[0].messages.len(), 2);
        assert_eq!(first.items[0].messages[0].id, "l:f:INBOX:1:4");
        let second = threads(&mut session, &account, &request(first.next_cursor), false)
            .await
            .unwrap();
        server.await.unwrap().unwrap();
        let ids: Vec<&str> = second.items.iter().map(|t| t.id.as_str()).collect();
        // B's older message (2) is left out: B was on the first page.
        assert_eq!(ids, ["<c1@x>", "<d1@x>"]);
        assert_eq!(second.next_cursor, None);
        assert_eq!(account.listed_in("<a1@x>").as_deref(), Some("INBOX"));
    }

    #[test]
    fn searches_by_the_kind_of_key() {
        assert_eq!(
            thread_search("<a@x>").unwrap().0.render(false),
            "UID SEARCH UNDELETED OR OR HEADER Message-ID \"<a@x>\" HEADER References \"<a@x>\" HEADER In-Reply-To \"<a@x>\""
        );
        assert_eq!(
            thread_search("t:T-1").unwrap().0.render(false),
            "UID SEARCH UNDELETED THREADID T-1"
        );
        assert_eq!(
            thread_search("g:123").unwrap().0.render(false),
            "UID SEARCH UNDELETED X-GM-THRID 123"
        );
        assert!(thread_search("t:a b").is_none());
        assert!(thread_search("x").is_none());
    }
}
