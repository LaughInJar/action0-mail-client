//! Changing mail and folders: flags, moving, deleting, emptying, marking
//! all read, creating, renaming and deleting folders, and storing a message
//! (`imap_append`).
//!
//! Moving uses MOVE where the server has it, else COPY, `\Deleted` and an
//! expunge. Deleting marks `\Deleted` and expunges. Expunging takes only the
//! messages meant: `UID EXPUNGE` with UIDPLUS; without it, a plain EXPUNGE
//! would also take messages another program marked `\Deleted`, so it's only
//! sent when no others are marked, else the messages stay marked (action0's
//! lists leave `\Deleted` messages out) until the folder is expunged.
//!
//! Message ids stay the same: COPYUID (and APPENDUID) say where messages
//! went; without them, `l:` ids are found again by their Message-ID, and
//! the server's own ids by searching for them when next needed.

use std::collections::HashMap;

use async_imap::imap_proto::{Response, ResponseCode};

use super::error::{ErrorKind, MailServerError};
use super::folders::{self, Folder, FolderStatus, FolderTree, leaf};
use super::ids::{self, Location, MailboxRef, Scheme, ServerIds, encode_mutf7};
use super::list;
use super::model::{CreateFolder, FlagsRequest, Mailbox, MoveRequest, Role, UpdateFolder};
use super::parse::HeaderInfo;
use super::proto::{self, Command, quote};
use super::read::{self, Group, open_group};
use super::session::{Access, ImapSession, Transport};
use super::state::Account;

/// Sets or clears `flags` (`\Seen \Flagged`) on UIDs of the open folder.
async fn store<S: Transport>(
    session: &mut ImapSession<S>,
    uids: &[u32],
    sign: char,
    flags: &str,
) -> Result<(), MailServerError> {
    for set in proto::uid_sets(uids) {
        let command = Command::new(format!("UID STORE {set} {sign}FLAGS.SILENT ({flags})"));
        proto::run(session, &command, |_| {}).await?;
    }
    Ok(())
}

/// Expunges `uids` (marked `\Deleted`) of the open folder (see the module
/// docs); false if they had to stay.
async fn expunge<S: Transport>(
    session: &mut ImapSession<S>,
    uids: &[u32],
) -> Result<bool, MailServerError> {
    if session.capabilities.has("UIDPLUS") {
        for set in proto::uid_sets(uids) {
            proto::run(session, &Command::new(format!("UID EXPUNGE {set}")), |_| {}).await?;
        }
        return Ok(true);
    }
    let marked = proto::search(session, &Command::new("UID SEARCH DELETED"))
        .await?
        .map_err(|refused| refused.error)?;
    if marked.iter().all(|uid| uids.contains(uid)) {
        proto::run(session, &Command::new("EXPUNGE"), |_| {}).await?;
        return Ok(true);
    }
    Ok(false)
}

/// `flags`: marks messages read or unread, flagged or not.
pub async fn flags<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &FlagsRequest,
) -> Result<(), MailServerError> {
    let mut add = Vec::new();
    let mut remove = Vec::new();
    for (wanted, flag) in [(request.seen, "\\Seen"), (request.flagged, "\\Flagged")] {
        match wanted {
            Some(true) => add.push(flag),
            Some(false) => remove.push(flag),
            None => {}
        }
    }
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let tree = folders::tree(session, account).await?;
    for Group {
        path,
        validity,
        members,
    } in read::locate(session, account, &tree, &request.ids).await?
    {
        if !open_group(session, &tree, &path, validity, Access::ReadWrite).await? {
            continue;
        }
        let uids: Vec<u32> = members.iter().map(|(_, uid)| *uid).collect();
        if !add.is_empty() {
            store(session, &uids, '+', &add.join(" ")).await?;
        }
        if !remove.is_empty() {
            store(session, &uids, '-', &remove.join(" ")).await?;
        }
    }
    Ok(())
}

/// A folder (not a view) by id, from `tree`.
fn folder<'t>(tree: &'t FolderTree, id: &str) -> Result<&'t Folder, MailServerError> {
    match ids::mailbox(id)? {
        MailboxRef::Folder(path) => tree
            .get(&path)
            .ok_or_else(|| MailServerError::not_found(format!("There's no folder {path}."))),
        _ => Err(MailServerError::server("That's a view, not a folder.")),
    }
}

/// `move`: moves messages into a folder.
pub async fn move_to<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &MoveRequest,
) -> Result<(), MailServerError> {
    let tree = folders::tree(session, account).await?;
    let target = folder(&tree, &request.to)?.clone();
    if !target.selectable {
        return Err(MailServerError::server(format!(
            "{} can't hold messages.",
            target.path
        )));
    }
    let scheme = Scheme::of(&session.capabilities);
    let has_move = session.capabilities.has("MOVE");
    let uidplus = session.capabilities.has("UIDPLUS");
    // Messages to find again in the target by Message-ID: (id, Message-ID).
    let mut lost: Vec<(String, String)> = Vec::new();
    for Group {
        path,
        validity,
        members,
    } in read::locate(session, account, &tree, &request.ids).await?
    {
        if path == target.path
            || !open_group(session, &tree, &path, validity, Access::ReadWrite).await?
        {
            continue;
        }
        let uids: Vec<u32> = members.iter().map(|(_, uid)| *uid).collect();
        let message_ids: HashMap<u32, String> = if scheme == Scheme::Local && !uidplus {
            list::fetch(session, &uids, "UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]")
                .await?
                .into_values()
                .filter_map(|row| Some((row.uid, HeaderInfo::read(&row.header).message_id?)))
                .collect()
        } else {
            HashMap::new()
        };
        let mut moved: HashMap<u32, u32> = HashMap::new();
        let mut target_validity = None;
        let verb = if has_move { "MOVE" } else { "COPY" };
        for set in proto::uid_sets(&uids) {
            let command = Command::new(format!("UID {verb} {set} {}", quote(&target.raw)));
            proto::run(session, &command, |response| {
                if let Some((validity, pairs)) = proto::copy_uid(response) {
                    target_validity = Some(validity);
                    moved.extend(pairs);
                }
            })
            .await?;
        }
        if !has_move {
            store(session, &uids, '+', "\\Deleted").await?;
            expunge(session, &uids).await?;
        }
        let mut ids = account.ids();
        for (id, uid) in members {
            match (target_validity, moved.get(&uid)) {
                (Some(validity), Some(new)) => ids.put(
                    &id,
                    Location {
                        path: target.path.clone(),
                        validity,
                        uid: *new,
                    },
                ),
                _ => {
                    ids.remove(&id);
                    if let Some(message_id) = message_ids.get(&uid) {
                        lost.push((id, message_id.clone()));
                    }
                }
            }
        }
    }
    if !lost.is_empty() {
        let selected = session.reopen_folder(&target.raw, Access::ReadOnly).await?;
        let validity = selected.mailbox.uid_validity.unwrap_or_default();
        for (id, message_id) in lost {
            let command = Command::new("UID SEARCH HEADER Message-ID ").string(message_id);
            let Ok(found) = proto::search(session, &command).await? else {
                continue;
            };
            let mut ids = account.ids();
            // The newest that's no other message yet (a copy may be there already).
            let uid = found.into_iter().rev().find(|uid| {
                ids.known_at(&Location {
                    path: target.path.clone(),
                    validity,
                    uid: *uid,
                })
                .is_none()
            });
            if let Some(uid) = uid {
                ids.put(
                    &id,
                    Location {
                        path: target.path.clone(),
                        validity,
                        uid,
                    },
                );
            }
        }
    }
    Ok(())
}

/// `delete`: deletes messages for good.
pub async fn delete<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    message_ids: &[String],
) -> Result<(), MailServerError> {
    let tree = folders::tree(session, account).await?;
    for Group {
        path,
        validity,
        members,
    } in read::locate(session, account, &tree, message_ids).await?
    {
        if !open_group(session, &tree, &path, validity, Access::ReadWrite).await? {
            continue;
        }
        let uids: Vec<u32> = members.iter().map(|(_, uid)| *uid).collect();
        store(session, &uids, '+', "\\Deleted").await?;
        expunge(session, &uids).await?;
        let mut ids = account.ids();
        for (id, _) in &members {
            ids.remove(id);
        }
        drop(ids);
        account.uncache(members.iter().map(|(id, _)| id.as_str()));
    }
    Ok(())
}

/// `empty`: deletes every message of a folder for good; how many.
pub async fn empty<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    mailbox_id: &str,
) -> Result<u32, MailServerError> {
    let tree = folders::tree(session, account).await?;
    let folder = folder(&tree, mailbox_id)?;
    let selected = session
        .reopen_folder(&folder.raw, Access::ReadWrite)
        .await?;
    let count = selected.mailbox.exists;
    if count == 0 {
        return Ok(0);
    }
    proto::run(
        session,
        &Command::new("STORE 1:* +FLAGS.SILENT (\\Deleted)"),
        |_| {},
    )
    .await?;
    proto::run(session, &Command::new("EXPUNGE"), |_| {}).await?;
    Ok(count)
}

/// `markAllRead`: marks a folder's or view's unread messages read; their ids.
pub async fn mark_all_read<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    mailbox_id: &str,
) -> Result<Vec<String>, MailServerError> {
    let tree = folders::tree(session, account).await?;
    let scheme = Scheme::of(&session.capabilities);
    let (folders, keys): (Vec<&Folder>, &str) = match ids::mailbox(mailbox_id)? {
        MailboxRef::Folder(_) => (vec![folder(&tree, mailbox_id)?], "UNSEEN UNDELETED"),
        MailboxRef::Flagged => (tree.searched(), "UNSEEN UNDELETED FLAGGED"),
        MailboxRef::All => (tree.searched(), "UNSEEN UNDELETED"),
    };
    let mut changed = Vec::new();
    for folder in folders.into_iter().filter(|folder| folder.selectable) {
        let selected = session.open_folder(&folder.raw, Access::ReadWrite).await?;
        let validity = selected.mailbox.uid_validity.unwrap_or_default();
        let uids = proto::search(session, &Command::new(format!("UID SEARCH {keys}")))
            .await?
            .map_err(|refused| refused.error)?;
        if uids.is_empty() {
            continue;
        }
        store(session, &uids, '+', "\\Seen").await?;
        let servers: HashMap<u32, ServerIds> = if scheme == Scheme::Local {
            HashMap::new()
        } else {
            list::fetch(session, &uids, &format!("UID{}", scheme.fetch_items()))
                .await?
                .into_values()
                .map(|row| (row.uid, row.server))
                .collect()
        };
        let mut ids = account.ids();
        for uid in uids {
            let location = Location {
                path: folder.path.clone(),
                validity,
                uid,
            };
            let server = servers.get(&uid).cloned().unwrap_or_default();
            changed.push(ids.identify(&location, &server));
        }
    }
    Ok(changed)
}

/// Sends a command, a NO or BAD being no error (`SUBSCRIBE`, which some
/// servers don't need).
async fn try_run<S: Transport>(
    session: &mut ImapSession<S>,
    command: String,
) -> Result<(), MailServerError> {
    let _ = proto::run_answered(session, &Command::new(command), |_| {}).await?;
    Ok(())
}

/// Leaves the open folder if it's `path` or below (servers don't like
/// renaming or deleting the open folder).
async fn leave<S: Transport>(
    session: &mut ImapSession<S>,
    folder: &Folder,
) -> Result<(), MailServerError> {
    let open = session.selected.as_ref().is_some_and(|selected| {
        selected.path == folder.raw
            || folder
                .delimiter
                .is_some_and(|d| selected.path.starts_with(&format!("{}{d}", folder.raw)))
    });
    if !open {
        return Ok(());
    }
    if session.capabilities.has("UNSELECT") {
        proto::run(session, &Command::new("UNSELECT"), |_| {}).await?;
        session.selected = None;
    } else {
        session.open_folder("INBOX", Access::ReadOnly).await?;
    }
    Ok(())
}

fn below(path: &str, ancestor: &str, delimiter: Option<char>) -> bool {
    delimiter.is_some_and(|d| path.starts_with(&format!("{ancestor}{d}")))
}

fn check_name(name: &str, delimiter: Option<char>) -> Result<String, MailServerError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(MailServerError::server("A folder needs a name."));
    }
    if let Some(d) = delimiter
        && name.contains(d)
    {
        return Err(MailServerError::server(format!(
            "A folder name can't contain “{d}”."
        )));
    }
    Ok(name.to_string())
}

/// Creates a folder at `path` (with its special use where the server
/// allows), subscribed; the folder as the tree would list it.
async fn create_at<S: Transport>(
    session: &mut ImapSession<S>,
    tree: &FolderTree,
    path: String,
    role: Option<Role>,
) -> Result<Folder, MailServerError> {
    if tree.get(&path).is_some() {
        return Err(MailServerError::new(
            ErrorKind::Exists,
            format!("A folder {path} exists."),
        ));
    }
    let raw = if tree.utf8 {
        path.clone()
    } else {
        encode_mutf7(&path)
    };
    let special = role
        .and_then(Role::attribute)
        .filter(|_| session.capabilities.has("CREATE-SPECIAL-USE"));
    let plain = Command::new(format!("CREATE {}", quote(&raw)));
    let created = match special {
        Some(attribute) => {
            let command = Command::new(format!("CREATE {} (USE ({attribute}))", quote(&raw)));
            match proto::run_answered(session, &command, |_| {}).await? {
                // The server may not take that special use: a plain folder then.
                Err(refused) if refused.error.kind != ErrorKind::Exists => {
                    proto::run_answered(session, &plain, |_| {}).await?
                }
                other => other,
            }
        }
        None => proto::run_answered(session, &plain, |_| {}).await?,
    };
    created.map_err(|refused| refused.error)?;
    try_run(session, format!("SUBSCRIBE {}", quote(&raw))).await?;
    Ok(Folder {
        path,
        raw,
        delimiter: tree.delimiter,
        selectable: true,
        role,
        aggregate: false,
        status: Some(FolderStatus {
            messages: Some(0),
            unseen: Some(0),
            ..FolderStatus::default()
        }),
    })
}

/// `createFolder`: creates a folder.
pub async fn create_folder<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &CreateFolder,
) -> Result<Mailbox, MailServerError> {
    let tree = folders::fresh_tree(session, account, None).await?;
    let name = check_name(&request.name, tree.delimiter)?;
    let parent = match &request.parent_id {
        Some(id) => Some(folder(&tree, id)?.path.clone()),
        None => None,
    };
    let path = tree.child_path(parent.as_deref(), &name);
    let created = create_at(session, &tree, path, request.role).await?;
    account.forget_tree();
    Ok(tree.mailbox(&created))
}

/// `updateFolder`: renames a folder or moves it elsewhere in the tree.
pub async fn update_folder<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    request: &UpdateFolder,
) -> Result<Mailbox, MailServerError> {
    let tree = folders::fresh_tree(session, account, None).await?;
    let current = folder(&tree, &request.id)?.clone();
    if current.role == Some(Role::Inbox) {
        return Err(MailServerError::server("The Inbox stays where it is."));
    }
    let delimiter = current.delimiter.or(tree.delimiter);
    let name = match request.name.as_deref() {
        Some(name) => check_name(name, delimiter)?,
        None => leaf(&current.path, current.delimiter).to_string(),
    };
    let parent = match &request.parent_id {
        None => tree.parent_of(&current),
        Some(None) => None,
        Some(Some(id)) => Some(folder(&tree, id)?.path.clone()),
    };
    if let Some(parent) = &parent
        && (*parent == current.path || below(parent, &current.path, delimiter))
    {
        return Err(MailServerError::server("A folder can't go into itself."));
    }
    let path = tree.child_path(parent.as_deref(), &name);
    if path == current.path {
        return Ok(tree.mailbox(&current));
    }
    if tree.get(&path).is_some() {
        return Err(MailServerError::new(
            ErrorKind::Exists,
            format!("A folder {path} exists."),
        ));
    }
    let raw = if tree.utf8 {
        path.clone()
    } else {
        encode_mutf7(&path)
    };
    leave(session, &current).await?;
    let command = Command::new(format!("RENAME {} {}", quote(&current.raw), quote(&raw)));
    proto::run(session, &command, |_| {}).await?;
    try_run(session, format!("SUBSCRIBE {}", quote(&raw))).await?;
    account.ids().rename_folder(&current.path, &path, delimiter);
    account.forget_tree();
    let renamed = Folder {
        path,
        raw,
        ..current
    };
    Ok(tree.mailbox(&renamed))
}

/// `deleteFolder`: moves a folder into Trash (created if there's none), or
/// deletes it for good (with its subfolders) if it's in Trash already.
pub async fn delete_folder<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    id: &str,
) -> Result<(), MailServerError> {
    let tree = folders::fresh_tree(session, account, None).await?;
    let current = folder(&tree, id)?.clone();
    if matches!(current.role, Some(Role::Inbox | Role::Trash)) {
        return Err(MailServerError::server("That folder can't be deleted."));
    }
    let delimiter = current.delimiter.or(tree.delimiter);
    leave(session, &current).await?;
    let trash = tree.role(Role::Trash).cloned();
    if let Some(trash) = &trash
        && below(&current.path, &trash.path, delimiter)
    {
        // Subfolders first, the deepest first.
        let mut doomed: Vec<&Folder> = tree
            .folders
            .iter()
            .filter(|f| f.path == current.path || below(&f.path, &current.path, delimiter))
            .collect();
        doomed.sort_by_key(|f| std::cmp::Reverse(f.path.matches(delimiter.unwrap_or('/')).count()));
        for folder in doomed {
            let command = Command::new(format!("DELETE {}", quote(&folder.raw)));
            match proto::run_answered(session, &command, |_| {}).await? {
                Err(refused) if refused.error.kind != ErrorKind::NotFound => {
                    return Err(refused.error);
                }
                _ => {}
            }
        }
        account.forget_tree();
        return Ok(());
    }
    let trash = match trash {
        Some(trash) => trash,
        None => {
            let path = tree.child_path(None, "Trash");
            create_at(session, &tree, path, Some(Role::Trash)).await?
        }
    };
    let d = trash.delimiter.or(delimiter).unwrap_or('/');
    let name = leaf(&current.path, current.delimiter);
    let mut path = format!("{}{d}{name}", trash.path);
    let mut number = 2;
    while tree.get(&path).is_some() {
        path = format!("{}{d}{name} {number}", trash.path);
        number += 1;
    }
    let raw = if tree.utf8 {
        path.clone()
    } else {
        encode_mutf7(&path)
    };
    let command = Command::new(format!("RENAME {} {}", quote(&current.raw), quote(&raw)));
    proto::run(session, &command, |_| {}).await?;
    try_run(session, format!("SUBSCRIBE {}", quote(&raw))).await?;
    account.ids().rename_folder(&current.path, &path, delimiter);
    account.forget_tree();
    Ok(())
}

/// A flag APPEND may set: a system flag or a keyword.
fn valid_flag(flag: &str) -> bool {
    let name = flag.strip_prefix('\\').unwrap_or(flag);
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"$_-.".contains(&b))
}

/// `imap_append`: stores a message in a folder with `flags`; its id.
pub async fn append<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    mailbox_id: &str,
    flags: &[String],
    message: Vec<u8>,
    now: i64,
) -> Result<String, MailServerError> {
    let tree = folders::tree(session, account).await?;
    let target = folder(&tree, mailbox_id)?.clone();
    let flags: Vec<&str> = flags
        .iter()
        .map(String::as_str)
        .filter(|flag| valid_flag(flag))
        .collect();
    let message_id = HeaderInfo::read(&message).message_id;
    let command = Command::new(format!(
        "APPEND {} ({}) \"{}\" ",
        quote(&target.raw),
        flags.join(" "),
        proto::date_time(now)
    ))
    .literal(message);
    let mut appended = None;
    proto::run(session, &command, |response| {
        if let Response::Done { outcome, .. } = response
            && let Some(ResponseCode::AppendUid(validity, uids)) = &outcome.code
        {
            appended = proto::expand(uids).last().map(|uid| (*validity, *uid));
        }
    })
    .await?;
    let (validity, uid) = match appended {
        Some(found) => found,
        None => {
            // Without UIDPLUS: found by its Message-ID (the newest such).
            let selected = session.reopen_folder(&target.raw, Access::ReadOnly).await?;
            let validity = selected.mailbox.uid_validity.unwrap_or_default();
            let search = match &message_id {
                Some(id) => Command::new("UID SEARCH HEADER Message-ID ").string(id.clone()),
                None => Command::new("UID SEARCH ALL"),
            };
            let uid = proto::search(session, &search)
                .await?
                .map_err(|refused| refused.error)?
                .into_iter()
                .max()
                .ok_or_else(|| {
                    MailServerError::server("The message was stored but can't be found again.")
                })?;
            (validity, uid)
        }
    };
    let location = Location {
        path: target.path.clone(),
        validity,
        uid,
    };
    let scheme = Scheme::of(&session.capabilities);
    let server = if scheme == Scheme::Local {
        ServerIds::default()
    } else {
        session.open_folder(&target.raw, Access::ReadOnly).await?;
        list::fetch(session, &[uid], &format!("UID{}", scheme.fetch_items()))
            .await?
            .remove(&uid)
            .map(|row| row.server)
            .unwrap_or_default()
    };
    Ok(account.ids().identify(&location, &server))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::model::FlagsRequest;
    use crate::imap::testing::logged_in;

    const LIST: &str = "
        C: A0003 LIST \"\" \"*\"
        S: * LIST (\\HasNoChildren) \"/\" INBOX
        S: * LIST (\\HasNoChildren) \"/\" Archive
        S: * LIST (\\HasChildren) \"/\" Trash
        S: * LIST (\\HasNoChildren) \"/\" Trash/Old
        S: * LIST (\\HasNoChildren) \"/\" Projects
        S: A0003 OK done
    ";

    #[tokio::test]
    async fn moves_with_move_and_follows_copyuid() {
        let script = format!(
            "{LIST}
            C: A0004 SELECT \"INBOX\"
            S: * 9 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK [READ-WRITE] done
            C: A0005 UID MOVE 4:5 \"Archive\"
            S: * OK [COPYUID 7 4:5 20:21] moved
            S: * 4 EXPUNGE
            S: * 4 EXPUNGE
            S: A0005 OK done
            C: A0006 SELECT \"Archive\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 7] ok
            S: A0006 OK [READ-WRITE] done
            C: A0007 UID STORE 21 +FLAGS.SILENT (\\Seen)
            S: A0007 OK done
            C: A0008 UID STORE 21 -FLAGS.SILENT (\\Flagged)
            S: A0008 OK done
            "
        );
        let (mut session, server) = logged_in("IMAP4rev1 MOVE UIDPLUS", &script).await;
        let account = Account::default();
        let request = MoveRequest {
            ids: vec!["l:f:INBOX:1:4".into(), "l:f:INBOX:1:5".into()],
            to: "f:Archive".into(),
        };
        move_to(&mut session, &account, &request).await.unwrap();
        assert_eq!(
            account.ids().get("l:f:INBOX:1:5"),
            Some(&Location {
                path: "Archive".into(),
                validity: 7,
                uid: 21
            })
        );
        // The same id works where it is now.
        let flags = FlagsRequest {
            ids: vec!["l:f:INBOX:1:5".into()],
            seen: Some(true),
            flagged: Some(false),
        };
        super::flags(&mut session, &account, &flags).await.unwrap();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn copies_and_expunges_only_its_own_without_move() {
        let script = format!(
            "{LIST}
            C: A0004 SELECT \"INBOX\"
            S: * 9 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK done
            C: A0005 UID FETCH 4 (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])
            S: * 1 FETCH (UID 4 BODY[HEADER.FIELDS (MESSAGE-ID)] {{21}}
            S: Message-ID: <m@x>
            S:
            S: )
            S: A0005 OK done
            C: A0006 UID COPY 4 \"Archive\"
            S: A0006 OK done
            C: A0007 UID STORE 4 +FLAGS.SILENT (\\Deleted)
            S: A0007 OK done
            C: A0008 UID SEARCH DELETED
            S: * SEARCH 2 4
            S: A0008 OK done
            C: A0009 EXAMINE \"Archive\"
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 7] ok
            S: A0009 OK done
            C: A0010 UID SEARCH HEADER Message-ID \"<m@x>\"
            S: * SEARCH 12 30
            S: A0010 OK done
            "
        );
        let (mut session, server) = logged_in("IMAP4rev1", &script).await;
        let account = Account::default();
        let request = MoveRequest {
            ids: vec!["l:f:INBOX:1:4".into()],
            to: "f:Archive".into(),
        };
        move_to(&mut session, &account, &request).await.unwrap();
        server.await.unwrap().unwrap();
        // Message 2 was marked by someone else: no EXPUNGE. Found again by Message-ID.
        assert_eq!(account.ids().get("l:f:INBOX:1:4").unwrap().uid, 30);
    }

    #[tokio::test]
    async fn deletes_with_uid_expunge_or_a_plain_one_when_nothing_else_is_marked() {
        let script = format!(
            "{LIST}
            C: A0004 SELECT \"Trash/Old\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 2] ok
            S: A0004 OK done
            C: A0005 UID STORE 8 +FLAGS.SILENT (\\Deleted)
            S: A0005 OK done
            C: A0006 UID EXPUNGE 8
            S: * 1 EXPUNGE
            S: A0006 OK done
            "
        );
        let (mut session, server) = logged_in("IMAP4rev1 UIDPLUS", &script).await;
        let account = Account::default();
        account.ids().put(
            "e:X",
            Location {
                path: "Trash/Old".into(),
                validity: 2,
                uid: 8,
            },
        );
        delete(&mut session, &account, &["e:X".into()])
            .await
            .unwrap();
        server.await.unwrap().unwrap();
        assert_eq!(account.ids().get("e:X"), None);

        let script = format!(
            "{LIST}
            C: A0004 SELECT \"INBOX\"
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0004 OK done
            C: A0005 UID STORE 3 +FLAGS.SILENT (\\Deleted)
            S: A0005 OK done
            C: A0006 UID SEARCH DELETED
            S: * SEARCH 3
            S: A0006 OK done
            C: A0007 EXPUNGE
            S: * 2 EXPUNGE
            S: A0007 OK done
            "
        );
        let (mut session, server) = logged_in("IMAP4rev1", &script).await;
        delete(&mut session, &Account::default(), &["l:f:INBOX:1:3".into()])
            .await
            .unwrap();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn appends_and_reads_appenduid() {
        let message = b"Message-ID: <new@x>\r\nSubject: Draft\r\n\r\nHi\r\n".to_vec();
        let script = format!(
            "{LIST}
            C: A0004 APPEND \"Projects\" (\\Draft \\Seen) \"{}\" {{{}}}
            S: + go ahead
            C: Message-ID: <new@x>
            C: Subject: Draft
            C:
            C: Hi
            C:
            S: A0004 OK [APPENDUID 3 77] stored
            ",
            proto::date_time(1_792_000_000_000),
            message.len()
        );
        let (mut session, server) = logged_in("IMAP4rev1 UIDPLUS", &script).await;
        let account = Account::default();
        let flags = vec![
            "\\Draft".to_string(),
            "\\Seen".to_string(),
            "bad flag)".to_string(),
        ];
        let id = append(
            &mut session,
            &account,
            "f:Projects",
            &flags,
            message,
            1_792_000_000_000,
        )
        .await
        .unwrap();
        server.await.unwrap().unwrap();
        assert_eq!(id, "l:f:Projects:3:77");
    }

    fn list_as(tag: &str) -> String {
        LIST.replace("A0003", tag)
    }

    #[tokio::test]
    async fn manages_folders() {
        let script = format!(
            "{}
            C: A0004 CREATE \"Archive/2026\" (USE (\\Archive))
            S: A0004 NO [USEATTR] Not here
            C: A0005 CREATE \"Archive/2026\"
            S: A0005 OK done
            C: A0006 SUBSCRIBE \"Archive/2026\"
            S: A0006 OK done
            {}
            C: A0008 RENAME \"Projects\" \"Archive/Projekte &AMQ-\"
            S: A0008 OK done
            C: A0009 SUBSCRIBE \"Archive/Projekte &AMQ-\"
            S: A0009 NO not today
            {}
            C: A0011 RENAME \"Archive\" \"Trash/Archive\"
            S: A0011 OK done
            C: A0012 SUBSCRIBE \"Trash/Archive\"
            S: A0012 OK done
            {}
            C: A0014 DELETE \"Trash/Old\"
            S: A0014 OK done
            ",
            list_as("A0003"),
            list_as("A0007"),
            list_as("A0010"),
            list_as("A0013"),
        );
        let (mut session, server) = logged_in("IMAP4rev1 CREATE-SPECIAL-USE", &script).await;
        let account = Account::default();
        let created = create_folder(
            &mut session,
            &account,
            &CreateFolder {
                name: " 2026 ".into(),
                parent_id: Some("f:Archive".into()),
                role: Some(Role::Archive),
            },
        )
        .await
        .unwrap();
        assert_eq!(created.id, "f:Archive/2026");
        assert_eq!(created.parent_id.as_deref(), Some("f:Archive"));
        let renamed = update_folder(
            &mut session,
            &account,
            &UpdateFolder {
                id: "f:Projects".into(),
                name: Some("Projekte Ä".into()),
                parent_id: Some(Some("f:Archive".into())),
            },
        )
        .await
        .unwrap();
        assert_eq!(renamed.id, "f:Archive/Projekte Ä");
        assert_eq!(renamed.name, "Projekte Ä");
        delete_folder(&mut session, &account, "f:Archive")
            .await
            .unwrap();
        delete_folder(&mut session, &account, "f:Trash/Old")
            .await
            .unwrap();
        server.await.unwrap().unwrap();
    }

    #[test]
    fn checks_folder_names_and_flags() {
        assert_eq!(check_name(" Kunden ", Some('/')).unwrap(), "Kunden");
        assert!(check_name("a/b", Some('/')).is_err());
        assert!(check_name("  ", None).is_err());
        assert!(valid_flag("\\Seen") && valid_flag("$Forwarded"));
        assert!(!valid_flag("a b") && !valid_flag("\\") && !valid_flag("x)"));
    }
}
