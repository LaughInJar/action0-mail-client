//! Send later and Snooze from the Android background check, for IMAP
//! accounts: drafts marked with a time that are due go out over SMTP (see
//! `crate::scheduled`), like the app sends them: without the marker and
//! the Bcc header, dated now, with a copy in Sent unless the server keeps
//! one, and the draft deleted. Snoozed mail that's due goes back into the
//! Inbox.

use super::error::MailServerError;
use super::folders;
use super::ids::folder_id;
use super::list;
use super::model::Role;
use super::parse::{self, BACK_KEYWORD, HeaderInfo, SEND_AT_HEADER};
use super::proto::{self, Command, quote};
use super::session::{Access, ImapSession, Login, Transport};
use super::smtp::{self, Envelope};
use super::state::Account;
use super::tls::Connector;
use super::write;
use crate::scheduled::{Marker, parse_iso_utc, rewrite_headers, rfc5322_utc};

/// Sends the account's due drafts; their subjects. `saves_sent`: the server
/// keeps a copy of sent mail itself (Gmail).
pub async fn send_due<S: Transport>(
    session: &mut ImapSession<S>,
    smtp_login: &Login<'_>,
    tls: &Connector,
    saves_sent: bool,
    device: &str,
    now: u64,
) -> Result<Vec<String>, MailServerError> {
    let account = Account::default();
    let tree = folders::tree(session, &account).await?;
    let Some(drafts) = tree
        .role(Role::Drafts)
        .filter(|folder| folder.selectable)
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let sent_folder = tree.role(Role::Sent).cloned();
    session.open_folder(&drafts.raw, Access::ReadWrite).await?;
    let search = Command::new(format!("UID SEARCH UNDELETED HEADER {SEND_AT_HEADER} \"\""));
    let uids = proto::search(session, &search)
        .await?
        .map_err(|refused| refused.error)?;
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let items = format!(
        "UID BODY.PEEK[HEADER.FIELDS ({})]",
        SEND_AT_HEADER.to_ascii_uppercase()
    );
    let mut due: Vec<u32> = list::fetch(session, &uids, &items)
        .await?
        .into_values()
        .filter(|row| {
            HeaderInfo::read(&row.header)
                .send_at
                .and_then(|value| Marker::parse(&value))
                .is_some_and(|marker| marker.is_due(now, device))
        })
        .map(|row| row.uid)
        .collect();
    due.sort_unstable();
    let mut sent = Vec::new();
    for uid in due {
        let rows = list::fetch(session, &[uid], "UID BODY.PEEK[]").await?;
        let Some(raw) = rows.get(&uid).and_then(|row| row.body.clone()) else {
            continue;
        };
        let message = rewrite_headers(&raw, &[SEND_AT_HEADER], Some(&rfc5322_utc(now)));
        let info = HeaderInfo::read(&message);
        let Some(from) = info.from.as_ref().map(|from| from.address.clone()) else {
            continue;
        };
        let to: Vec<String> = info
            .to
            .iter()
            .chain(&info.cc)
            .chain(&info.bcc)
            .map(|address| address.address.clone())
            .collect();
        smtp::send(
            smtp_login,
            tls,
            &Envelope { from, to },
            &rewrite_headers(&message, &["Bcc"], None),
        )
        .await?;
        if !saves_sent && let Some(folder) = &sent_folder {
            // The copy keeps its Bcc, like the app's.
            write::append(
                session,
                &account,
                &folder_id(&folder.path),
                &["\\Seen".to_string()],
                message,
                i64::try_from(now).unwrap_or_default(),
            )
            .await?;
            session.open_folder(&drafts.raw, Access::ReadWrite).await?;
        }
        write::store(session, &[uid], '+', "\\Deleted").await?;
        write::expunge(session, &[uid]).await?;
        sent.push(info.subject);
    }
    Ok(sent)
}

/// Snoozed mail that's due goes back into the Inbox, unread and marked
/// (`$A0Back`), its time's keyword cleared; its subjects.
pub async fn wake_due<S: Transport>(
    session: &mut ImapSession<S>,
    now: u64,
) -> Result<Vec<String>, MailServerError> {
    let tree = folders::tree(session, &Account::default()).await?;
    let (Some(snoozed), Some(inbox)) = (
        tree.role(Role::Snoozed)
            .filter(|folder| folder.selectable)
            .cloned(),
        tree.role(Role::Inbox).cloned(),
    ) else {
        return Ok(Vec::new());
    };
    session.open_folder(&snoozed.raw, Access::ReadWrite).await?;
    let uids = proto::search(session, &Command::new("UID SEARCH UNDELETED"))
        .await?
        .map_err(|refused| refused.error)?;
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = list::fetch(
        session,
        &uids,
        "UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)]",
    )
    .await?;
    let mut due: Vec<u32> = Vec::new();
    let mut old: Vec<String> = Vec::new();
    let mut subjects = Vec::new();
    for row in rows.into_values() {
        let back = parse::snoozed_until(&row.keywords)
            .and_then(|until| parse_iso_utc(&until))
            .is_some_and(|at| at <= now);
        if !back {
            continue;
        }
        due.push(row.uid);
        old.extend(
            row.keywords
                .iter()
                .filter(|keyword| {
                    keyword
                        .get(..parse::SNOOZE_PREFIX.len())
                        .is_some_and(|start| start.eq_ignore_ascii_case(parse::SNOOZE_PREFIX))
                })
                .cloned(),
        );
        subjects.push(HeaderInfo::read(&row.header).subject);
    }
    if due.is_empty() {
        return Ok(Vec::new());
    }
    due.sort_unstable();
    old.sort();
    old.dedup();
    let clear = [old, vec!["\\Seen".to_string()]].concat().join(" ");
    write::store(session, &due, '-', &clear).await?;
    write::store(session, &due, '+', BACK_KEYWORD).await?;
    for set in proto::uid_sets(&due) {
        if session.capabilities.has("MOVE") {
            let command = Command::new(format!("UID MOVE {set} {}", quote(&inbox.raw)));
            proto::run(session, &command, |_| {}).await?;
        } else {
            let command = Command::new(format!("UID COPY {set} {}", quote(&inbox.raw)));
            proto::run(session, &command, |_| {}).await?;
        }
    }
    if !session.capabilities.has("MOVE") {
        write::store(session, &due, '+', "\\Deleted").await?;
        write::expunge(session, &due).await?;
    }
    Ok(subjects)
}
