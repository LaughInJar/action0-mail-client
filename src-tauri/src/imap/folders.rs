//! An account's folders: LIST (with special uses and counts where the server
//! returns them in one go, else STATUS per folder), their roles (special use,
//! else the name, German names included, also under `INBOX.`), the tree and
//! the views.

use std::collections::HashMap;
use std::sync::Arc;

use async_imap::imap_proto::{MailboxDatum, NameAttribute, Response, StatusAttribute};

use super::error::MailServerError;
use super::ids::{self, decode_mutf7, encode_mutf7, folder_id};
use super::model::{Counts, Mailbox, MailboxKind, Role};
use super::proto::{self, Command, quote};
use super::session::{ImapSession, Transport};
use super::state::Account;

/// STATUS commands sent together (when the server has no LIST-STATUS).
const STATUS_BATCH: usize = 50;

/// Folder names that give a role (lower case), checked at the top level and
/// right under INBOX when the server marks no folder with that special use.
const ROLE_NAMES: &[(Role, &[&str])] = &[
    (
        Role::Sent,
        &[
            "sent",
            "sent items",
            "sent messages",
            "sent mail",
            "gesendet",
            "gesendete objekte",
            "gesendete elemente",
        ],
    ),
    (Role::Drafts, &["drafts", "entwürfe"]),
    (
        Role::Trash,
        &[
            "trash",
            "deleted items",
            "deleted messages",
            "papierkorb",
            "gelöschte elemente",
            "gelöschte objekte",
        ],
    ),
    (Role::Junk, &["junk", "spam", "junk e-mail", "junk-e-mail"]),
    (Role::Archive, &["archive", "archives", "archiv"]),
];

/// What STATUS said about a folder.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FolderStatus {
    pub messages: Option<u32>,
    pub unseen: Option<u32>,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
    pub highest_modseq: Option<u64>,
}

impl FolderStatus {
    fn read(attributes: &[StatusAttribute]) -> Self {
        let mut status = Self::default();
        for attribute in attributes {
            match attribute {
                StatusAttribute::Messages(n) => status.messages = Some(*n),
                StatusAttribute::Unseen(n) => status.unseen = Some(*n),
                StatusAttribute::UidNext(n) => status.uid_next = Some(*n),
                StatusAttribute::UidValidity(n) => status.uid_validity = Some(*n),
                StatusAttribute::HighestModSeq(n) => status.highest_modseq = Some(*n),
                _ => {}
            }
        }
        status
    }
}

/// A folder as LIST named it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    /// As the server names it.
    pub raw: String,
    pub delimiter: Option<char>,
    pub selectable: bool,
    /// Its special use, if the server says.
    pub special: Option<Role>,
    pub status: Option<FolderStatus>,
}

/// Lists every folder, with `status` items (`MESSAGES UNSEEN`, …) for the
/// selectable ones if asked: in the LIST where the server has LIST-STATUS,
/// else with STATUS commands sent together.
pub async fn list<S: Transport>(
    session: &mut ImapSession<S>,
    status: Option<&str>,
) -> Result<Vec<Listed>, MailServerError> {
    let capabilities = &session.capabilities;
    let extended = capabilities.has("LIST-EXTENDED") || capabilities.has("IMAP4REV2");
    let list_status = capabilities.has("LIST-STATUS") || capabilities.has("IMAP4REV2");
    let mut returns = Vec::new();
    if extended && capabilities.has("SPECIAL-USE") {
        returns.push("SPECIAL-USE".to_string());
    }
    if let Some(items) = status
        && list_status
    {
        returns.push(format!("STATUS ({items})"));
    }
    let mut command = "LIST \"\" \"*\"".to_string();
    if !returns.is_empty() {
        command.push_str(&format!(" RETURN ({})", returns.join(" ")));
    }
    let mut listed: Vec<Listed> = Vec::new();
    let mut statuses: HashMap<String, FolderStatus> = HashMap::new();
    proto::run(session, &Command::new(command), |response| {
        read_list(response, &mut listed, &mut statuses);
    })
    .await?;
    if let Some(items) = status
        && !list_status
    {
        let selectable: Vec<String> = listed
            .iter()
            .filter(|folder| folder.selectable)
            .map(|folder| format!("STATUS {} ({items})", quote(&folder.raw)))
            .collect();
        for batch in selectable.chunks(STATUS_BATCH) {
            // A folder that vanished meanwhile just has no counts.
            proto::run_all(session, batch, |response| {
                read_list(response, &mut Vec::new(), &mut statuses);
            })
            .await?;
        }
    }
    for folder in &mut listed {
        let found = statuses.get(&folder.raw).or_else(|| {
            folder
                .raw
                .eq_ignore_ascii_case("INBOX")
                .then(|| {
                    statuses
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("INBOX"))
                        .map(|(_, status)| status)
                })
                .flatten()
        });
        if folder.selectable {
            folder.status = found.copied();
        }
    }
    Ok(listed)
}

/// The account's folders: as last listed, else listed now (without counts).
pub async fn tree<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
) -> Result<Arc<FolderTree>, MailServerError> {
    match account.tree() {
        Some(tree) => Ok(tree),
        None => fresh_tree(session, account, None).await,
    }
}

/// The account's folders listed now (with `status` items, if asked), kept
/// for the operations that need paths and roles.
pub async fn fresh_tree<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
    status: Option<&str>,
) -> Result<Arc<FolderTree>, MailServerError> {
    let listed = list(session, status).await?;
    let tree = Arc::new(FolderTree::build(
        listed,
        session.enabled.has("UTF8=ACCEPT"),
    ));
    account.set_tree(tree.clone());
    Ok(tree)
}

/// `folders`: the folders with their counts, and the views.
pub async fn folders<S: Transport>(
    session: &mut ImapSession<S>,
    account: &Account,
) -> Result<Vec<Mailbox>, MailServerError> {
    Ok(fresh_tree(session, account, Some("MESSAGES UNSEEN"))
        .await?
        .mailboxes())
}

/// Notes a LIST or STATUS answer.
fn read_list(
    response: &Response<'_>,
    listed: &mut Vec<Listed>,
    statuses: &mut HashMap<String, FolderStatus>,
) {
    match response {
        Response::MailboxData(MailboxDatum::List(data)) => {
            let mut selectable = true;
            let mut special = None;
            for attribute in &data.name_attributes {
                match attribute {
                    NameAttribute::NoSelect => selectable = false,
                    NameAttribute::Extension(name)
                        if name.eq_ignore_ascii_case("\\NonExistent") =>
                    {
                        selectable = false
                    }
                    NameAttribute::All => special = Some(Role::All),
                    NameAttribute::Archive => special = Some(Role::Archive),
                    NameAttribute::Drafts => special = Some(Role::Drafts),
                    NameAttribute::Flagged => special = Some(Role::Flagged),
                    NameAttribute::Junk => special = Some(Role::Junk),
                    NameAttribute::Sent => special = Some(Role::Sent),
                    NameAttribute::Trash => special = Some(Role::Trash),
                    _ => {}
                }
            }
            // A folder named twice (LIST-EXTENDED servers may) counts once.
            if !listed.iter().any(|folder| folder.raw == data.name) {
                listed.push(Listed {
                    raw: data.name.to_string(),
                    delimiter: data.delimiter.as_deref().and_then(|d| d.chars().next()),
                    selectable,
                    special,
                    status: None,
                });
            }
        }
        Response::MailboxData(MailboxDatum::Status { mailbox, status }) => {
            statuses.insert(mailbox.to_string(), FolderStatus::read(status));
        }
        _ => {}
    }
}

/// A folder as the UI and the operations know it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    /// The path in its id (decoded).
    pub path: String,
    /// As the server names it (for commands).
    pub raw: String,
    pub delimiter: Option<char>,
    pub selectable: bool,
    pub role: Option<Role>,
    /// A special-use \All or \Flagged folder: it shows other folders' mail.
    pub aggregate: bool,
    pub status: Option<FolderStatus>,
}

/// An account's folders, as last listed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderTree {
    pub folders: Vec<Folder>,
    /// The usual hierarchy delimiter.
    pub delimiter: Option<char>,
    /// `INBOX.` (with the delimiter) where every folder lives below the
    /// Inbox (Courier, Cyrus): they show at the top level, and new ones go
    /// there too.
    pub prefix: Option<String>,
    /// Folder names are UTF-8 (UTF8=ACCEPT), not modified UTF-7.
    pub utf8: bool,
}

impl FolderTree {
    pub fn build(listed: Vec<Listed>, utf8: bool) -> Self {
        let mut counts: HashMap<char, usize> = HashMap::new();
        for folder in &listed {
            if let Some(d) = folder.delimiter {
                *counts.entry(d).or_default() += 1;
            }
        }
        let delimiter = counts
            .into_iter()
            .max_by_key(|(d, count)| (*count, *d == '/'))
            .map(|(d, _)| d);
        let mut folders: Vec<Folder> = listed
            .into_iter()
            .map(|listed| {
                let inbox = listed.raw.eq_ignore_ascii_case("INBOX");
                let path = if utf8 {
                    listed.raw.clone()
                } else {
                    decode_mutf7(&listed.raw).unwrap_or_else(|| listed.raw.clone())
                };
                Folder {
                    // The Inbox (and what's below it) is spelled one way.
                    path: match listed.delimiter.and_then(|d| below_inbox_rest(&path, d)) {
                        _ if inbox => "INBOX".to_string(),
                        Some(rest) => format!("INBOX{}{rest}", listed.delimiter.unwrap_or('/')),
                        None => path,
                    },
                    raw: listed.raw,
                    delimiter: listed.delimiter,
                    selectable: listed.selectable,
                    role: if inbox {
                        Some(Role::Inbox)
                    } else {
                        listed.special
                    },
                    aggregate: matches!(listed.special, Some(Role::All | Role::Flagged)),
                    status: listed.status,
                }
            })
            .collect();

        // One folder per special use: the first one keeps it.
        let mut taken: Vec<Role> = Vec::new();
        for folder in &mut folders {
            if let Some(role) = folder.role {
                if taken.contains(&role) {
                    folder.role = None;
                } else {
                    taken.push(role);
                }
            }
        }
        // Roles by name, for those no folder has by special use.
        for (role, names) in ROLE_NAMES {
            if taken.contains(role) {
                continue;
            }
            let found = folders.iter_mut().find(|folder| {
                let top = match folder.delimiter {
                    Some(d) => !folder.path.contains(d) || inbox_child(&folder.path, d),
                    None => true,
                };
                folder.role.is_none()
                    && folder.selectable
                    && top
                    && names.contains(&leaf(&folder.path, folder.delimiter).to_lowercase().as_str())
            });
            if let Some(folder) = found {
                folder.role = Some(*role);
                taken.push(*role);
            }
        }

        let prefix = delimiter.and_then(|d| {
            let others: Vec<&Folder> = folders
                .iter()
                .filter(|folder| folder.role != Some(Role::Inbox))
                .collect();
            let all_below =
                !others.is_empty() && others.iter().all(|folder| below_inbox(&folder.path, d));
            let with_roles = others
                .iter()
                .any(|folder| folder.role.is_some() && inbox_child(&folder.path, d));
            (all_below && with_roles).then(|| format!("INBOX{d}"))
        });

        // Parents that LIST didn't name: there, but not selectable.
        let mut missing: Vec<Folder> = Vec::new();
        for folder in &folders {
            let mut path = folder.path.clone();
            while let Some(parent) = parent_path(&path, folder.delimiter) {
                let known = folders
                    .iter()
                    .chain(missing.iter())
                    .any(|f| f.path == parent);
                if !known && parent != "INBOX" {
                    missing.push(Folder {
                        raw: if utf8 {
                            parent.clone()
                        } else {
                            encode_mutf7(&parent)
                        },
                        path: parent.clone(),
                        delimiter: folder.delimiter,
                        selectable: false,
                        role: None,
                        aggregate: false,
                        status: None,
                    });
                }
                path = parent;
            }
        }
        folders.extend(missing);
        folders.sort_by(|a, b| {
            let rank = |f: &Folder| f.role.map_or(100, |role| role.rank());
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
        });
        Self {
            folders,
            delimiter,
            prefix,
            utf8,
        }
    }

    pub fn get(&self, path: &str) -> Option<&Folder> {
        self.folders.iter().find(|folder| folder.path == path)
    }

    pub fn role(&self, role: Role) -> Option<&Folder> {
        self.folders.iter().find(|folder| folder.role == Some(role))
    }

    /// The name to send for `path`: as listed, else encoded.
    pub fn raw(&self, path: &str) -> String {
        match self.get(path) {
            Some(folder) => folder.raw.clone(),
            None if self.utf8 => path.to_string(),
            None => encode_mutf7(path),
        }
    }

    /// The folders the views search: every selectable one but Trash, Junk
    /// and the server's own \All and \Flagged.
    pub fn searched(&self) -> Vec<&Folder> {
        self.folders
            .iter()
            .filter(|folder| {
                folder.selectable
                    && !folder.aggregate
                    && !matches!(folder.role, Some(Role::Trash | Role::Junk))
            })
            .collect()
    }

    /// The parent's path shown in the tree (none at the top, or right below
    /// the INBOX prefix).
    pub fn parent_of(&self, folder: &Folder) -> Option<String> {
        let parent = parent_path(&folder.path, folder.delimiter)?;
        let shown_at_top = self
            .prefix
            .as_deref()
            .is_some_and(|prefix| format!("{parent}{}", folder.delimiter.unwrap_or('/')) == prefix);
        (!shown_at_top).then_some(parent)
    }

    pub fn mailbox(&self, folder: &Folder) -> Mailbox {
        Mailbox {
            id: folder_id(&folder.path),
            name: if folder.role == Some(Role::Inbox) {
                "Inbox".to_string()
            } else {
                leaf(&folder.path, folder.delimiter).to_string()
            },
            parent_id: self.parent_of(folder).map(|path| folder_id(&path)),
            kind: MailboxKind::Folder,
            role: folder.role,
            selectable: folder.selectable,
            hidden: false,
            assignable: folder.selectable
                && !matches!(
                    folder.role,
                    Some(Role::Sent | Role::Drafts | Role::All | Role::Flagged)
                ),
            counts: folder.status.and_then(|status| {
                Some(Counts {
                    unread: status.unseen?,
                    total: status.messages?,
                })
            }),
        }
    }

    /// The folders and the views, in the UI's order.
    pub fn mailboxes(&self) -> Vec<Mailbox> {
        let mut mailboxes: Vec<Mailbox> = self.folders.iter().map(|f| self.mailbox(f)).collect();
        let view = |id: &str, name: &str, role: Role, hidden: bool| Mailbox {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: None,
            kind: MailboxKind::View,
            role: Some(role),
            selectable: true,
            hidden,
            assignable: false,
            counts: None,
        };
        if self.role(Role::Flagged).is_none() {
            let at = mailboxes
                .iter()
                .position(|m| m.role.is_none_or(|role| role.rank() > Role::Flagged.rank()))
                .unwrap_or(mailboxes.len());
            mailboxes.insert(at, view(ids::FLAGGED, "Flagged", Role::Flagged, false));
        }
        if self.role(Role::All).is_none() {
            let at = mailboxes
                .iter()
                .position(|m| m.role.is_none_or(|role| role.rank() > Role::All.rank()))
                .unwrap_or(mailboxes.len());
            mailboxes.insert(at, view(ids::ALL, "All mail", Role::All, true));
        }
        mailboxes
    }

    /// The path of a new folder `name` below `parent` (none: the top level).
    pub fn child_path(&self, parent: Option<&str>, name: &str) -> String {
        let d = self.delimiter.unwrap_or('/');
        match (parent, &self.prefix) {
            (Some(parent), _) => format!("{parent}{d}{name}"),
            (None, Some(prefix)) => format!("{prefix}{name}"),
            (None, None) => name.to_string(),
        }
    }
}

/// A folder's own name: what follows its last delimiter.
pub fn leaf(path: &str, delimiter: Option<char>) -> &str {
    match delimiter {
        Some(d) => path.rsplit(d).next().unwrap_or(path),
        None => path,
    }
}

/// The path above `path`, if any.
pub fn parent_path(path: &str, delimiter: Option<char>) -> Option<String> {
    let (parent, _) = path.rsplit_once(delimiter?)?;
    (!parent.is_empty()).then(|| parent.to_string())
}

/// What follows `INBOX<d>` in `path`, if that's how it starts.
fn below_inbox_rest(path: &str, d: char) -> Option<&str> {
    let start = path.get(..5)?;
    let rest = path[5..].strip_prefix(d)?;
    (start.eq_ignore_ascii_case("INBOX") && !rest.is_empty()).then_some(rest)
}

/// `path` is somewhere below the Inbox.
fn below_inbox(path: &str, d: char) -> bool {
    below_inbox_rest(path, d).is_some()
}

/// `path` is right below the Inbox.
fn inbox_child(path: &str, d: char) -> bool {
    below_inbox_rest(path, d).is_some_and(|rest| !rest.contains(d))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::testing::logged_in;

    fn listed(raw: &str, special: Option<Role>) -> Listed {
        Listed {
            raw: raw.into(),
            delimiter: Some('/'),
            selectable: true,
            special,
            status: None,
        }
    }

    #[tokio::test]
    async fn lists_with_special_uses_and_counts_in_one_go() {
        let (mut session, script) = logged_in(
            "IMAP4rev1 LIST-EXTENDED LIST-STATUS SPECIAL-USE",
            "
            C: A0003 LIST \"\" \"*\" RETURN (SPECIAL-USE STATUS (MESSAGES UNSEEN))
            S: * LIST (\\HasNoChildren) \"/\" INBOX
            S: * STATUS INBOX (MESSAGES 12 UNSEEN 3)
            S: * LIST (\\HasNoChildren \\Sent) \"/\" \"Gesendet\"
            S: * STATUS \"Gesendet\" (MESSAGES 4 UNSEEN 0)
            S: * LIST (\\HasChildren \\Noselect) \"/\" \"Projekte\"
            S: * LIST (\\HasNoChildren) \"/\" \"Projekte/Entw&APw-rfe\"
            S: * STATUS \"Projekte/Entw&APw-rfe\" (MESSAGES 1 UNSEEN 1)
            S: * LIST (\\HasNoChildren \\Trash) \"/\" \"Papierkorb\"
            S: * STATUS \"Papierkorb\" (MESSAGES 0 UNSEEN 0)
            S: A0003 OK List completed
            ",
        )
        .await;
        let folders = list(&mut session, Some("MESSAGES UNSEEN")).await.unwrap();
        script.await.unwrap().unwrap();
        let tree = FolderTree::build(folders, false);
        let mailboxes = tree.mailboxes();
        let summary: Vec<(String, Option<Role>, Option<String>, bool)> = mailboxes
            .iter()
            .map(|m| (m.id.clone(), m.role, m.parent_id.clone(), m.selectable))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("f:INBOX".into(), Some(Role::Inbox), None, true),
                ("v:flagged".into(), Some(Role::Flagged), None, true),
                ("f:Gesendet".into(), Some(Role::Sent), None, true),
                ("v:all".into(), Some(Role::All), None, true),
                ("f:Papierkorb".into(), Some(Role::Trash), None, true),
                ("f:Projekte".into(), None, None, false),
                (
                    "f:Projekte/Entwürfe".into(),
                    None,
                    Some("f:Projekte".into()),
                    true
                ),
            ]
        );
        assert_eq!(mailboxes[0].name, "Inbox");
        assert_eq!(
            mailboxes[0].counts,
            Some(Counts {
                unread: 3,
                total: 12
            })
        );
        assert!(!mailboxes[2].assignable);
        assert!(mailboxes[3].hidden);
        // A name below another folder doesn't give a role.
        assert_eq!(mailboxes[6].name, "Entwürfe");
        assert_eq!(tree.raw("Projekte/Entwürfe"), "Projekte/Entw&APw-rfe");
        assert_eq!(tree.raw("Neu/Grüße"), "Neu/Gr&APwA3w-e");
    }

    #[tokio::test]
    async fn asks_each_folder_without_list_status() {
        let (mut session, script) = logged_in(
            "IMAP4rev1",
            "
            C: A0003 LIST \"\" \"*\"
            S: * LIST (\\HasNoChildren) \".\" INBOX
            S: * LIST (\\HasNoChildren) \".\" INBOX.Sent
            S: * LIST (\\HasNoChildren) \".\" INBOX.Drafts
            S: * LIST (\\HasNoChildren) \".\" \"INBOX.Gel&APY-schte Elemente\"
            S: * LIST (\\HasNoChildren) \".\" INBOX.Kunden
            S: A0003 OK done
            C: A0004 STATUS \"INBOX\" (MESSAGES UNSEEN)
            C: A0005 STATUS \"INBOX.Sent\" (MESSAGES UNSEEN)
            C: A0006 STATUS \"INBOX.Drafts\" (MESSAGES UNSEEN)
            C: A0007 STATUS \"INBOX.Gel&APY-schte Elemente\" (MESSAGES UNSEEN)
            C: A0008 STATUS \"INBOX.Kunden\" (MESSAGES UNSEEN)
            S: * STATUS INBOX (MESSAGES 2 UNSEEN 1)
            S: A0004 OK done
            S: * STATUS INBOX.Sent (MESSAGES 0 UNSEEN 0)
            S: A0005 OK done
            S: A0006 NO [NONEXISTENT] gone
            S: * STATUS \"INBOX.Gel&APY-schte Elemente\" (MESSAGES 5 UNSEEN 0)
            S: A0007 OK done
            S: * STATUS INBOX.Kunden (MESSAGES 7 UNSEEN 7)
            S: A0008 OK done
            ",
        )
        .await;
        let folders = list(&mut session, Some("MESSAGES UNSEEN")).await.unwrap();
        script.await.unwrap().unwrap();
        let tree = FolderTree::build(folders, false);
        assert_eq!(tree.prefix.as_deref(), Some("INBOX."));
        assert_eq!(tree.role(Role::Sent).unwrap().path, "INBOX.Sent");
        assert_eq!(tree.role(Role::Drafts).unwrap().path, "INBOX.Drafts");
        assert_eq!(
            tree.role(Role::Trash).unwrap().path,
            "INBOX.Gelöschte Elemente"
        );
        let mailboxes = tree.mailboxes();
        let kunden = mailboxes.iter().find(|m| m.id == "f:INBOX.Kunden").unwrap();
        // Shown at the top level, like the role folders.
        assert_eq!(kunden.parent_id, None);
        assert_eq!(kunden.name, "Kunden");
        assert_eq!(
            kunden.counts,
            Some(Counts {
                unread: 7,
                total: 7
            })
        );
        let drafts = mailboxes.iter().find(|m| m.id == "f:INBOX.Drafts").unwrap();
        assert_eq!(drafts.counts, None);
        assert_eq!(tree.child_path(None, "Archiv"), "INBOX.Archiv");
        assert_eq!(tree.child_path(Some("INBOX.Kunden"), "A"), "INBOX.Kunden.A");
    }

    #[test]
    fn knows_gmails_folders() {
        let mut gmail = listed("[Gmail]", None);
        gmail.selectable = false;
        let tree = FolderTree::build(
            vec![
                listed("INBOX", None),
                gmail,
                listed("[Gmail]/All Mail", Some(Role::All)),
                listed("[Gmail]/Sent Mail", Some(Role::Sent)),
                listed("[Gmail]/Starred", Some(Role::Flagged)),
                listed("[Gmail]/Spam", Some(Role::Junk)),
                listed("[Gmail]/Trash", Some(Role::Trash)),
                listed("Sent", None),
            ],
            true,
        );
        let mailboxes = tree.mailboxes();
        // The server's \All and \Flagged play the views' roles.
        assert!(mailboxes.iter().all(|m| m.kind == MailboxKind::Folder));
        let all = mailboxes
            .iter()
            .find(|m| m.role == Some(Role::All))
            .unwrap();
        assert_eq!(all.id, "f:[Gmail]/All Mail");
        assert_eq!(all.parent_id.as_deref(), Some("f:[Gmail]"));
        assert!(!all.assignable);
        // A folder named Sent doesn't take the role from the special use.
        let sent: Vec<_> = mailboxes
            .iter()
            .filter(|m| m.role == Some(Role::Sent))
            .collect();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, "f:[Gmail]/Sent Mail");
        let searched: Vec<&str> = tree.searched().iter().map(|f| f.path.as_str()).collect();
        assert_eq!(searched, ["INBOX", "[Gmail]/Sent Mail", "Sent"]);
        assert_eq!(tree.prefix, None);
    }

    #[test]
    fn names_give_roles_case_insensitively() {
        let tree = FolderTree::build(
            vec![
                listed("INBOX", None),
                listed("Junk E-Mail", None),
                listed("ARCHIV", None),
                listed("Entw&APw-rfe", None),
                listed("Kunden/Sent", None),
            ],
            false,
        );
        assert_eq!(tree.role(Role::Junk).unwrap().path, "Junk E-Mail");
        assert_eq!(tree.role(Role::Archive).unwrap().path, "ARCHIV");
        assert_eq!(tree.role(Role::Drafts).unwrap().path, "Entwürfe");
        assert_eq!(tree.role(Role::Sent), None);
        // An INBOX child doesn't make the INBOX a namespace without role folders there.
        assert_eq!(tree.prefix, None);
    }
}
