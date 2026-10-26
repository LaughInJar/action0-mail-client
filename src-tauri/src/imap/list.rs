//! Lists: a folder's or view's messages as pages of rows.
//!
//! A list starts with a snapshot of its UIDs in order (`UID SORT (REVERSE
//! ARRIVAL)` where the server sorts, else `UID SEARCH` in UID order); pages
//! are slices of it, so paging doesn't skip or repeat while mail arrives.
//! The cursor names the snapshot and the offset (`<snapshot>:<offset>`);
//! when the snapshot is gone (a restart, or too many lists since) a new one
//! is taken. Views search every folder but Trash and Junk and merge by
//! INTERNALDATE.
//!
//! A page's rows come from one FETCH: flags, INTERNALDATE, BODYSTRUCTURE,
//! the address and threading header fields, and the server's ids. Snippets
//! are the server's PREVIEW where it has one, else the start (2 KB) of the
//! text part, decoded. If the server's answer can't be read (an unusual
//! BODYSTRUCTURE), the page is fetched again without it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use async_imap::imap_proto::{
    AttributeValue, BodyContentCommon, BodyContentSinglePart, BodyStructure, ContentEncoding,
    MessageSection, Response, SectionPath, Status,
};

use super::error::MailServerError;
use super::folders::{self, FolderTree};
use super::ids::{self, Location, MailboxRef, Scheme, ServerIds, folder_id};
use super::model::{Flags, ListQuery, Order, Page, Summary};
use super::parse::{self, HeaderInfo};
use super::proto::{self, Command, next_answer};
use super::search::Query;
use super::session::{Access, ImapSession, Transport};
use super::state::Account;

/// The most rows a page may ask for.
const MAX_LIMIT: usize = 500;
/// How much of a text part a snippet is made from.
const SNIPPET_BYTES: usize = 2048;
/// The newest messages per folder a view merges.
const VIEW_PER_FOLDER: usize = 2000;
/// Lists kept for paging, per account.
const KEPT_SNAPSHOTS: usize = 20;
/// The header fields a row needs.
pub const HEADER_FIELDS: &str = "BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING)]";

/// What a FETCH said about one message.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub uid: u32,
    pub flags_known: bool,
    pub seen: bool,
    pub flagged: bool,
    pub deleted: bool,
    pub draft: bool,
    /// INTERNALDATE, ms since 1970.
    pub date: i64,
    pub modseq: Option<u64>,
    pub server: ServerIds,
    /// The header fields asked for.
    pub header: Vec<u8>,
    /// `BODY[]` or a part's `BODY[…]`.
    pub body: Option<Vec<u8>>,
    pub structure: Option<Structure>,
}

impl Row {
    /// A FETCH answer's items; `None` without a UID.
    pub fn read(attributes: &[AttributeValue<'_>]) -> Option<Self> {
        let mut row = Row::default();
        let mut uid = None;
        for attribute in attributes {
            match attribute {
                AttributeValue::Uid(n) => uid = Some(*n),
                AttributeValue::Flags(flags) => {
                    row.flags_known = true;
                    for flag in flags {
                        match flag.to_ascii_lowercase().as_str() {
                            "\\seen" => row.seen = true,
                            "\\flagged" => row.flagged = true,
                            "\\deleted" => row.deleted = true,
                            "\\draft" => row.draft = true,
                            _ => {}
                        }
                    }
                }
                AttributeValue::InternalDate(date) => {
                    row.date = proto::parse_internal_date(date).unwrap_or_default();
                }
                AttributeValue::ModSeq(n) => row.modseq = Some(*n),
                AttributeValue::EmailId(id) => row.server.email_id = Some(id.to_string()),
                AttributeValue::ThreadId(id) => {
                    row.server.thread_id = id.as_ref().map(|id| id.to_string());
                }
                AttributeValue::GmailMsgId(id) => row.server.gm_msgid = Some(*id),
                AttributeValue::GmailThrId(id) => row.server.gm_thrid = Some(*id),
                AttributeValue::BodyStructure(body) => row.structure = Some(Structure::read(body)),
                AttributeValue::BodySection {
                    section: Some(SectionPath::Full(MessageSection::Header)),
                    data: Some(data),
                    ..
                } => row.header = data.to_vec(),
                AttributeValue::BodySection {
                    data: Some(data), ..
                }
                | AttributeValue::Rfc822(Some(data)) => row.body = Some(data.to_vec()),
                _ => {}
            }
        }
        row.uid = uid?;
        Some(row)
    }

    /// Adds what a later answer for the same message said.
    fn merge(&mut self, later: Row) {
        if later.flags_known {
            self.flags_known = true;
            self.seen = later.seen;
            self.flagged = later.flagged;
            self.deleted = later.deleted;
            self.draft = later.draft;
        }
        if later.date != 0 {
            self.date = later.date;
        }
        self.modseq = later.modseq.or(self.modseq);
        let server = later.server;
        self.server.email_id = server.email_id.or(self.server.email_id.take());
        self.server.thread_id = server.thread_id.or(self.server.thread_id.take());
        self.server.gm_msgid = server.gm_msgid.or(self.server.gm_msgid);
        self.server.gm_thrid = server.gm_thrid.or(self.server.gm_thrid);
        if !later.header.is_empty() {
            self.header = later.header;
        }
        if later.body.is_some() {
            self.body = later.body;
        }
        if later.structure.is_some() {
            self.structure = later.structure;
        }
    }

    pub fn location(&self, path: &str, validity: u32) -> Location {
        Location {
            path: path.to_string(),
            validity,
            uid: self.uid,
        }
    }
}

/// What BODYSTRUCTURE says that a row needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Structure {
    /// Something is attached (not counting inline images).
    pub attachments: bool,
    /// The part a snippet comes from: the first text/plain, else text/html.
    pub text: Option<TextPart>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextPart {
    pub path: String,
    pub html: bool,
    pub charset: Option<String>,
    pub encoding: String,
}

fn param<'a>(
    params: &'a Option<Vec<(std::borrow::Cow<'_, str>, std::borrow::Cow<'a, str>)>>,
    name: &str,
) -> Option<&'a str> {
    params.as_ref()?.iter().find_map(|(key, value)| {
        let key = key.to_ascii_lowercase();
        (key == name || key.strip_suffix('*') == Some(name)).then_some(value.as_ref())
    })
}

impl Structure {
    pub fn read(body: &BodyStructure<'_>) -> Self {
        let mut structure = Self::default();
        let mut plain = None;
        let mut html = None;
        walk(
            body,
            String::new(),
            &mut structure.attachments,
            &mut plain,
            &mut html,
        );
        structure.text = plain.or(html);
        structure
    }
}

fn walk(
    body: &BodyStructure<'_>,
    path: String,
    attachments: &mut bool,
    plain: &mut Option<TextPart>,
    html: &mut Option<TextPart>,
) {
    let (common, other) = match body {
        BodyStructure::Multipart { bodies, .. } => {
            for (index, child) in bodies.iter().enumerate() {
                let child_path = if path.is_empty() {
                    (index + 1).to_string()
                } else {
                    format!("{path}.{}", index + 1)
                };
                walk(child, child_path, attachments, plain, html);
            }
            return;
        }
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        | BodyStructure::Message { common, other, .. } => (common, other),
    };
    let path = if path.is_empty() {
        "1".to_string()
    } else {
        path
    };
    if is_attachment(common, other) {
        *attachments = true;
        return;
    }
    if let BodyStructure::Text { .. } = body {
        let subtype = common.ty.subtype.to_ascii_lowercase();
        let part = TextPart {
            path,
            html: subtype == "html",
            charset: param(&common.ty.params, "charset").map(str::to_string),
            encoding: match &other.transfer_encoding {
                ContentEncoding::SevenBit => "7bit".into(),
                ContentEncoding::EightBit => "8bit".into(),
                ContentEncoding::Binary => "binary".into(),
                ContentEncoding::Base64 => "base64".into(),
                ContentEncoding::QuotedPrintable => "quoted-printable".into(),
                ContentEncoding::Other(other) => other.to_string(),
            },
        };
        match subtype.as_str() {
            "plain" if plain.is_none() => *plain = Some(part),
            "html" if html.is_none() => *html = Some(part),
            _ => {}
        }
    }
}

/// An attachment: marked so, an attached message, or anything with a file
/// name except inline images.
fn is_attachment(common: &BodyContentCommon<'_>, other: &BodyContentSinglePart<'_>) -> bool {
    let disposition = common
        .disposition
        .as_ref()
        .map(|d| d.ty.to_ascii_lowercase());
    if disposition.as_deref() == Some("attachment") {
        return true;
    }
    let ty = common.ty.ty.to_ascii_lowercase();
    if ty == "message" && common.ty.subtype.eq_ignore_ascii_case("rfc822") {
        return true;
    }
    let named = common
        .disposition
        .as_ref()
        .and_then(|d| param(&d.params, "filename"))
        .or_else(|| param(&common.ty.params, "name"))
        .is_some();
    let inline_image =
        ty == "image" && (disposition.as_deref() == Some("inline") || other.id.is_some());
    named && !inline_image
}

/// `UID FETCH <uids> (<items>)`: the rows of the UIDs asked for.
pub async fn fetch<S: Transport>(
    session: &mut ImapSession<S>,
    uids: &[u32],
    items: &str,
) -> Result<HashMap<u32, Row>, MailServerError> {
    let mut rows: HashMap<u32, Row> = HashMap::new();
    let wanted: HashSet<u32> = uids.iter().copied().collect();
    for set in proto::uid_sets(uids) {
        let command = Command::new(format!("UID FETCH {set} ({items})"));
        proto::run(session, &command, |response| {
            if let Response::Fetch(_, attributes) = response
                && let Some(row) = Row::read(attributes)
                && wanted.contains(&row.uid)
            {
                match rows.get_mut(&row.uid) {
                    Some(known) => known.merge(row),
                    None => {
                        rows.insert(row.uid, row);
                    }
                }
            }
        })
        .await?;
    }
    Ok(rows)
}

/// `UID FETCH <set> (<items>)` for a set such as `100:*`: every row it gives.
pub async fn fetch_set<S: Transport>(
    session: &mut ImapSession<S>,
    set: &str,
    items: &str,
    extra: &str,
) -> Result<HashMap<u32, Row>, MailServerError> {
    let mut rows: HashMap<u32, Row> = HashMap::new();
    let mut vanished = Vec::new();
    let command = Command::new(format!("UID FETCH {set} ({items}){extra}"));
    proto::run(session, &command, |response| match response {
        Response::Fetch(_, attributes) => {
            if let Some(row) = Row::read(attributes) {
                match rows.get_mut(&row.uid) {
                    Some(known) => known.merge(row),
                    None => {
                        rows.insert(row.uid, row);
                    }
                }
            }
        }
        Response::Vanished { uids, .. } => {
            vanished.extend(uids.iter().flat_map(|range| range.clone()));
        }
        _ => {}
    })
    .await?;
    // Vanished UIDs come back as rows marked deleted, for the caller to see.
    for uid in vanished {
        rows.insert(
            uid,
            Row {
                uid,
                flags_known: true,
                deleted: true,
                ..Row::default()
            },
        );
    }
    Ok(rows)
}

/// The items of a row's FETCH (`rich`: with BODYSTRUCTURE).
pub fn row_items(scheme: Scheme, rich: bool) -> String {
    format!(
        "UID FLAGS INTERNALDATE {}{HEADER_FIELDS}{}",
        if rich { "BODYSTRUCTURE " } else { "" },
        scheme.fetch_items()
    )
}

/// The server's PREVIEWs (RFC 8970) of `uids`, read from the raw answers.
async fn previews<S: Transport>(
    session: &mut ImapSession<S>,
    uids: &[u32],
) -> Result<HashMap<u32, String>, MailServerError> {
    let mut found = HashMap::new();
    for set in proto::uid_sets(uids) {
        let tag = session
            .run_command(format!("UID FETCH {set} (UID PREVIEW)"))
            .await?;
        loop {
            let response = next_answer!(session)?;
            match response.parsed() {
                Response::Done {
                    tag: done, status, ..
                } if *done == tag => {
                    if *status != Status::Ok {
                        return Ok(found);
                    }
                    break;
                }
                Response::Fetch(..) => {
                    if let Some((uid, preview)) = proto::raw_preview(response.borrow_owner()) {
                        found.insert(uid, parse::one_line(&preview));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(found)
}

/// Snippets of `rows`: PREVIEW, else the start of the text part (rich rows)
/// or of the body after the header (the others).
async fn snippets<S: Transport>(
    session: &mut ImapSession<S>,
    rows: &[&Row],
) -> Result<HashMap<u32, String>, MailServerError> {
    let mut found = HashMap::new();
    if rows.is_empty() {
        return Ok(found);
    }
    if session.capabilities.has("PREVIEW") {
        let uids: Vec<u32> = rows.iter().map(|row| row.uid).collect();
        found = previews(session, &uids).await?;
    }
    let mut by_part: Vec<(String, Vec<&Row>)> = Vec::new();
    for row in rows.iter().filter(|row| !found.contains_key(&row.uid)) {
        let section = match &row.structure {
            Some(Structure {
                text: Some(part), ..
            }) => part.path.clone(),
            Some(Structure { text: None, .. }) => continue,
            None => "TEXT".to_string(),
        };
        match by_part.iter_mut().find(|(path, _)| *path == section) {
            Some((_, group)) => group.push(row),
            None => by_part.push((section, vec![row])),
        }
    }
    for (section, group) in by_part {
        let uids: Vec<u32> = group.iter().map(|row| row.uid).collect();
        let items = format!("UID BODY.PEEK[{section}]<0.{SNIPPET_BYTES}>");
        let starts = fetch(session, &uids, &items).await?;
        for row in group {
            let Some(bytes) = starts.get(&row.uid).and_then(|start| start.body.as_deref()) else {
                continue;
            };
            let snippet = match &row.structure {
                Some(Structure {
                    text: Some(part), ..
                }) => parse::snippet(bytes, part.html, part.charset.as_deref(), &part.encoding),
                _ => parse::snippet_after(&row.header, bytes),
            };
            found.insert(row.uid, snippet);
        }
    }
    Ok(found)
}

/// A row as the UI's summary.
pub fn summary_of(row: &Row, id: String, path: &str, snippet: String) -> Summary {
    let info = HeaderInfo::read(&row.header);
    Summary {
        thread_id: parse::thread_key(&row.server, &info, &id),
        id,
        mailbox_ids: vec![folder_id(path)],
        from: info.from,
        to: info.to,
        subject: info.subject,
        snippet,
        received_at: proto::iso(row.date),
        flags: Flags {
            seen: row.seen,
            flagged: row.flagged,
        },
        has_attachments: match &row.structure {
            Some(structure) => structure.attachments,
            None => info.content_type.as_deref() == Some("multipart/mixed"),
        },
    }
}

/// A folder in a snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapFolder {
    pub path: String,
    pub raw: String,
    pub validity: u32,
}

/// The summaries of `uids` in `folder` (by UID): those gone or deleted
/// meanwhile, or all if its UIDVALIDITY changed, are left out.
pub async fn summaries<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    folder: &SnapFolder,
    uids: &[u32],
    rich: bool,
) -> Result<HashMap<u32, Summary>, MailServerError> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    let scheme = Scheme::of(&session.capabilities);
    let selected = session.open_folder(&folder.raw, Access::ReadOnly).await?;
    let validity = selected.mailbox.uid_validity.unwrap_or_default();
    if folder.validity != 0 && validity != folder.validity {
        return Ok(HashMap::new());
    }
    let rows = fetch(session, uids, &row_items(scheme, rich)).await?;
    let mut rows: Vec<&Row> = rows.values().filter(|row| !row.deleted).collect();
    rows.sort_by_key(|row| row.uid);
    let mut snippets = snippets(session, &rows).await?;
    let mut ids = account.ids();
    Ok(rows
        .into_iter()
        .map(|row| {
            let id = ids.identify(&row.location(&folder.path, validity), &row.server);
            let snippet = snippets.remove(&row.uid).unwrap_or_default();
            (row.uid, summary_of(row, id, &folder.path, snippet))
        })
        .collect())
}

/// A list's messages in order, taken when its first page was asked for.
#[derive(Debug, Default)]
pub struct Snapshot {
    /// The list it's of (mailbox, search, order, rows or threads).
    pub key: String,
    pub folders: Vec<SnapFolder>,
    /// (index in `folders`, UID), in the list's order.
    pub entries: Vec<(usize, u32)>,
    /// Conversation lists: where each conversation shown so far first came
    /// (its index in `entries`), so later pages leave it out.
    pub first_seen: Mutex<HashMap<String, usize>>,
}

/// The snapshots of an account's lists, the newest last.
#[derive(Debug)]
pub struct Snapshots {
    /// Tells this run's snapshot names from an earlier run's.
    run: u32,
    next: u64,
    kept: VecDeque<(String, Arc<Snapshot>)>,
}

impl Default for Snapshots {
    fn default() -> Self {
        Self {
            run: rand::random(),
            next: 1,
            kept: VecDeque::new(),
        }
    }
}

impl Snapshots {
    fn get(&self, id: &str, key: &str) -> Option<Arc<Snapshot>> {
        self.kept
            .iter()
            .find(|(name, snapshot)| name == id && snapshot.key == key)
            .map(|(_, snapshot)| snapshot.clone())
    }

    fn keep(&mut self, snapshot: Snapshot) -> (String, Arc<Snapshot>) {
        let id = format!("{:x}.{}", self.run, self.next);
        self.next += 1;
        let snapshot = Arc::new(snapshot);
        self.kept.push_back((id.clone(), snapshot.clone()));
        while self.kept.len() > KEPT_SNAPSHOTS {
            self.kept.pop_front();
        }
        (id, snapshot)
    }
}

pub fn cursor(snapshot: &str, offset: usize) -> String {
    format!("{snapshot}:{offset}")
}

fn parse_cursor(cursor: &str) -> Option<(&str, usize)> {
    let (id, offset) = cursor.rsplit_once(':')?;
    Some((id, offset.parse().ok()?))
}

/// The snapshot a list's page comes from, its name and the page's offset.
pub async fn snapshot_for<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &ListQuery,
    kind: &str,
) -> Result<(Arc<Snapshot>, String, usize), MailServerError> {
    let order = request.order.unwrap_or_default();
    let key = format!(
        "{kind}\n{}\n{}\n{order:?}",
        request.mailbox_id,
        request.search.as_deref().unwrap_or_default().trim()
    );
    let mut offset = 0;
    if let Some((id, at)) = request.cursor.as_deref().and_then(parse_cursor) {
        offset = at;
        let kept = account.snapshots.lock().expect("imap lock").get(id, &key);
        if let Some(snapshot) = kept {
            return Ok((snapshot, id.to_string(), offset));
        }
    }
    let tree = folders::tree(session, account).await?;
    let mut snapshot = take(
        session,
        &tree,
        &request.mailbox_id,
        request.search.as_deref(),
        order,
    )
    .await?;
    snapshot.key = key;
    let (id, snapshot) = account.snapshots.lock().expect("imap lock").keep(snapshot);
    Ok((snapshot, id, offset))
}

/// Takes a snapshot of a mailbox's (matching) messages.
async fn take<S: Transport>(
    session: &mut ImapSession<S>,
    tree: &FolderTree,
    mailbox_id: &str,
    search: Option<&str>,
    order: Order,
) -> Result<Snapshot, MailServerError> {
    let gmail = session.capabilities.has("X-GM-EXT-1");
    let query = Query::new(search, gmail);
    let newest = order == Order::Newest;
    let mut snapshot = Snapshot::default();
    let (folders, keys) = match ids::mailbox(mailbox_id)? {
        MailboxRef::Folder(path) => {
            let folder = tree
                .get(&path)
                .ok_or_else(|| MailServerError::not_found(format!("There's no folder {path}.")))?;
            if !folder.selectable {
                return Ok(snapshot);
            }
            let raw = folder.raw.clone();
            // Opened again: a folder kept open shows its counts as of then.
            let selected = session.reopen_folder(&raw, Access::ReadOnly).await?;
            let validity = selected.mailbox.uid_validity.unwrap_or_default();
            let exists = selected.mailbox.exists;
            snapshot.folders.push(SnapFolder {
                path,
                raw,
                validity,
            });
            if exists == 0 {
                return Ok(snapshot);
            }
            let uids = if session.capabilities.has("SORT") {
                uids_of(proto::search(session, &query.sort("UNDELETED", newest)).await?)?
            } else {
                let utf8 = session.enabled.has("UTF8=ACCEPT");
                let mut uids =
                    uids_of(proto::search(session, &query.search("UNDELETED", utf8)).await?)?;
                uids.sort_unstable();
                if newest {
                    uids.reverse();
                }
                uids
            };
            snapshot.entries = uids.into_iter().map(|uid| (0, uid)).collect();
            return Ok(snapshot);
        }
        MailboxRef::Flagged => (tree.searched(), "UNDELETED FLAGGED"),
        MailboxRef::All => (tree.searched(), "UNDELETED"),
    };
    let utf8 = session.enabled.has("UTF8=ACCEPT");
    let mut dated: Vec<(i64, usize, u32)> = Vec::new();
    for folder in folders {
        let selected = session.reopen_folder(&folder.raw, Access::ReadOnly).await?;
        let validity = selected.mailbox.uid_validity.unwrap_or_default();
        if selected.mailbox.exists == 0 {
            continue;
        }
        let mut uids = uids_of(proto::search(session, &query.search(keys, utf8)).await?)?;
        if uids.is_empty() {
            continue;
        }
        uids.sort_unstable();
        let newest_uids = &uids[uids.len().saturating_sub(VIEW_PER_FOLDER)..];
        let index = snapshot.folders.len();
        snapshot.folders.push(SnapFolder {
            path: folder.path.clone(),
            raw: folder.raw.clone(),
            validity,
        });
        let dates = fetch(session, newest_uids, "UID INTERNALDATE").await?;
        dated.extend(dates.values().map(|row| (row.date, index, row.uid)));
    }
    dated.sort_unstable();
    if newest {
        dated.reverse();
    }
    snapshot.entries = dated
        .into_iter()
        .map(|(_, folder, uid)| (folder, uid))
        .collect();
    Ok(snapshot)
}

/// A search's UIDs, or why the server refused it.
fn uids_of(answer: Result<Vec<u32>, proto::Refusal>) -> Result<Vec<u32>, MailServerError> {
    answer.map_err(|refused| match refused.code.as_deref() {
        Some("BADCHARSET") => {
            MailServerError::server("The mail server can't search for these characters.")
        }
        _ => refused.error,
    })
}

/// The summaries of snapshot `entries`, one for each (`None`: gone meanwhile).
pub async fn page_summaries<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    snapshot: &Snapshot,
    entries: &[(usize, u32)],
    rich: bool,
) -> Result<Vec<Option<Summary>>, MailServerError> {
    let mut by_folder: Vec<(usize, Vec<u32>)> = Vec::new();
    for (folder, uid) in entries {
        match by_folder.iter_mut().find(|(index, _)| index == folder) {
            Some((_, uids)) => uids.push(*uid),
            None => by_folder.push((*folder, vec![*uid])),
        }
    }
    let mut found: HashMap<(usize, u32), Summary> = HashMap::new();
    for (index, uids) in by_folder {
        let folder = &snapshot.folders[index];
        for (uid, summary) in summaries(session, account, folder, &uids, rich).await? {
            found.insert((index, uid), summary);
        }
    }
    Ok(entries.iter().map(|entry| found.remove(entry)).collect())
}

/// `list`: a page of a folder's or view's messages.
pub async fn list<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &ListQuery,
    rich: bool,
) -> Result<Page<Summary>, MailServerError> {
    let (snapshot, id, offset) = snapshot_for(session, account, request, "messages").await?;
    let limit = limit_of(request);
    let total = snapshot.entries.len();
    let start = offset.min(total);
    let end = (start + limit).min(total);
    let items = page_summaries(
        session,
        account,
        &snapshot,
        &snapshot.entries[start..end],
        rich,
    )
    .await?;
    Ok(Page {
        items: items.into_iter().flatten().collect(),
        next_cursor: (end < total).then(|| cursor(&id, end)),
    })
}

/// The page size a request may ask for.
pub fn limit_of(request: &ListQuery) -> usize {
    (request.limit as usize).clamp(1, MAX_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::testing::logged_in;

    fn query(mailbox: &str, search: Option<&str>, cursor: Option<&str>, limit: u32) -> ListQuery {
        ListQuery {
            mailbox_id: mailbox.into(),
            search: search.map(str::to_string),
            order: None,
            cursor: cursor.map(str::to_string),
            limit,
        }
    }

    const LIST: &str = "
        C: A0003 LIST \"\" \"*\"
        S: * LIST (\\HasNoChildren) \"/\" INBOX
        S: * LIST (\\HasNoChildren) \"/\" Trash
        S: A0003 OK done
    ";

    #[tokio::test]
    async fn lists_a_page_with_rows_and_snippets() {
        let rest = format!(
            "{LIST}
            C: A0004 EXAMINE \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 9] ok
            S: A0004 OK [READ-ONLY] done
            C: A0005 UID SORT (REVERSE ARRIVAL) US-ASCII UNDELETED
            S: * SORT 12 11 10
            S: A0005 OK done
            C: A0006 UID FETCH 11:12 (UID FLAGS INTERNALDATE BODYSTRUCTURE {HEADER_FIELDS})
            S: * 3 FETCH (UID 12 FLAGS (\\Seen \\Flagged) INTERNALDATE \"18-Oct-2026 12:00:00 +0200\" BODYSTRUCTURE ((\"text\" \"plain\" (\"charset\" \"iso-8859-1\") NIL NIL \"quoted-printable\" 20 1 NIL NIL NIL NIL)(\"application\" \"pdf\" (\"name\" \"a.pdf\") NIL NIL \"base64\" 100 NIL (\"attachment\" (\"filename\" \"a.pdf\")) NIL NIL) \"mixed\" (\"boundary\" \"x\") NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {{67}}
            S: From: Anna <anna@example.org>
            S: Subject: Hi
            S: Message-ID: <m12@x>
            S:
            S: )
            S: * 2 FETCH (UID 11 FLAGS () INTERNALDATE \"17-Oct-2026 08:00:00 +0000\" BODYSTRUCTURE (\"text\" \"html\" (\"charset\" \"utf-8\") NIL NIL \"7bit\" 30 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {{46}}
            S: From: bob@example.org
            S: References: <m12@x>
            S:
            S: )
            S: A0006 OK done
            C: A0007 UID FETCH 11:12 (UID BODY.PEEK[1]<0.2048>)
            S: * 3 FETCH (UID 12 BODY[1]<0> {{12}}
            S: Gr=FC=DFe!
            S: )
            S: * 2 FETCH (UID 11 BODY[1]<0> \"<p>Hello <b>there</b></p>\")
            S: A0007 OK done
            "
        );
        let (mut session, script) = logged_in("IMAP4rev1 SORT", &rest).await;
        let account = Account::default();
        let page = list(
            &mut session,
            &account,
            &query("f:INBOX", None, None, 2),
            true,
        )
        .await
        .unwrap();
        script.await.unwrap().unwrap();
        assert_eq!(page.items.len(), 2);
        let first = &page.items[0];
        assert_eq!(first.id, "l:f:INBOX:9:12");
        assert_eq!(first.subject, "Hi");
        assert_eq!(first.from.as_ref().unwrap().address, "anna@example.org");
        assert_eq!(first.thread_id, "<m12@x>");
        assert_eq!(first.received_at, "2026-10-18T10:00:00Z");
        assert!(first.flags.seen && first.flags.flagged);
        assert!(first.has_attachments);
        assert_eq!(first.snippet, "Grüße!");
        let second = &page.items[1];
        assert_eq!(second.thread_id, "<m12@x>");
        assert_eq!(second.snippet, "Hello there");
        assert!(!second.has_attachments);
        assert_eq!(second.subject, "");
        let cursor = page.next_cursor.unwrap();
        assert!(cursor.ends_with(":2"), "{cursor}");
        assert_eq!(account.ids().get("l:f:INBOX:9:11").unwrap().uid, 11);
    }

    #[tokio::test]
    async fn pages_through_a_snapshot_and_takes_a_new_one_when_its_gone() {
        let row = |seq: u32, uid: u32| {
            format!(
                "S: * {seq} FETCH (UID {uid} FLAGS () INTERNALDATE \"17-Oct-2026 08:00:00 +0000\" PREVIEW \"p{uid}\" BODY[HEADER.FIELDS (SUBJECT)] {{2}}\nS:\nS: )"
            )
        };
        let rest = format!(
            "{LIST}
            C: A0004 EXAMINE \"INBOX\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 9] ok
            S: A0004 OK done
            C: A0005 UID SEARCH UNDELETED FROM \"anna\"
            S: * SEARCH 3 5 4
            S: A0005 OK done
            C: A0006 UID FETCH 5 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0006 OK done
            C: A0007 UID FETCH 5 (UID PREVIEW)
            S: * 2 FETCH (UID 5 PREVIEW \"Hello from five\")
            S: A0007 OK done
            C: A0008 UID FETCH 4 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0008 OK done
            C: A0009 UID FETCH 4 (UID PREVIEW)
            S: * 1 FETCH (UID 4 PREVIEW \"four\")
            S: A0009 OK done
            C: A0010 EXAMINE \"INBOX\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 9] ok
            S: A0010 OK done
            C: A0011 UID SEARCH UNDELETED FROM \"anna\"
            S: * SEARCH 3 4
            S: A0011 OK done
            C: A0012 UID FETCH 3 (UID FLAGS INTERNALDATE {HEADER_FIELDS})
            {}
            S: A0012 OK done
            C: A0013 UID FETCH 3 (UID PREVIEW)
            S: * 1 FETCH (UID 3 PREVIEW NIL)
            S: A0013 OK done
            C: A0014 UID FETCH 3 (UID BODY.PEEK[TEXT]<0.2048>)
            S: * 1 FETCH (UID 3 BODY[TEXT]<0> \"plain\")
            S: A0014 OK done
            ",
            row(2, 5),
            row(1, 4),
            row(1, 3)
        );
        let (mut session, script) = logged_in("IMAP4rev1 PREVIEW", &rest).await;
        let account = Account::default();
        let first = list(
            &mut session,
            &account,
            &query("f:INBOX", Some("from:anna"), None, 1),
            false,
        )
        .await
        .unwrap();
        assert_eq!(first.items[0].snippet, "Hello from five");
        let second = list(
            &mut session,
            &account,
            &query(
                "f:INBOX",
                Some("from:anna"),
                first.next_cursor.as_deref(),
                1,
            ),
            false,
        )
        .await
        .unwrap();
        assert_eq!(second.items[0].id, "l:f:INBOX:9:4");
        // A cursor from an earlier run: a new snapshot, from the same offset.
        let third = list(
            &mut session,
            &account,
            &query("f:INBOX", Some("from:anna"), Some("old.1:1"), 1),
            false,
        )
        .await
        .unwrap();
        script.await.unwrap().unwrap();
        assert_eq!(third.items[0].id, "l:f:INBOX:9:3");
        assert_eq!(third.items[0].snippet, "plain");
        assert_eq!(third.next_cursor, None);
    }

    #[tokio::test]
    async fn merges_folders_in_a_view_by_date() {
        let rest = format!(
            "{LIST}
            C: A0004 EXAMINE \"INBOX\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK done
            C: A0005 UID SEARCH UNDELETED FLAGGED
            S: * SEARCH 7
            S: A0005 OK done
            C: A0006 UID FETCH 7 (UID INTERNALDATE)
            S: * 1 FETCH (UID 7 INTERNALDATE \"02-Jan-2026 00:00:00 +0000\")
            S: A0006 OK done
            "
        );
        let (mut session, script) = logged_in("IMAP4rev1", &rest).await;
        let tree = folders::tree(&mut session, &Account::default())
            .await
            .unwrap();
        let snapshot = take(&mut session, &tree, "v:flagged", None, Order::Newest)
            .await
            .unwrap();
        script.await.unwrap().unwrap();
        // Trash isn't searched.
        assert_eq!(snapshot.folders.len(), 1);
        assert_eq!(snapshot.entries, vec![(0, 7)]);
    }

    #[test]
    fn reads_body_structures() {
        // An inline image with a Content-ID isn't an attachment; an attached message is.
        let (_, attributes) = async_imap::imap_proto::Response::parse(
            b"* 1 FETCH (UID 1 BODYSTRUCTURE (((\"text\" \"html\" (\"charset\" \"utf-8\") NIL NIL \"base64\" 10 1 NIL NIL NIL NIL)(\"image\" \"png\" (\"name\" \"logo.png\") \"<logo>\" NIL \"base64\" 10 NIL (\"inline\" (\"filename\" \"logo.png\")) NIL NIL) \"related\" (\"boundary\" \"r\") NIL NIL NIL) \"mixed\" (\"boundary\" \"m\") NIL NIL NIL))\r\n",
        )
        .map(|(rest, response)| (rest, match response {
            Response::Fetch(_, attributes) => Row::read(&attributes).unwrap(),
            _ => unreachable!(),
        }))
        .unwrap();
        let structure = attributes.structure.unwrap();
        assert!(!structure.attachments);
        assert_eq!(
            structure.text,
            Some(TextPart {
                path: "1.1".into(),
                html: true,
                charset: Some("utf-8".into()),
                encoding: "base64".into(),
            })
        );
    }
}
