//! The ids the UI gets for folders and messages, and where messages are.
//!
//! Folders are `f:<path>`, with the path as the server names it (decoded
//! from modified UTF-7 unless UTF8=ACCEPT is on); the views are `v:flagged`
//! and `v:all`. A message keeps its id when it moves:
//!
//! - `e:<EMAILID>` where the server has OBJECTID (RFC 8474),
//! - `g:<X-GM-MSGID>` on Gmail,
//! - else `l:<folder id>:<UIDVALIDITY>:<UID>` from where action0 first saw it.
//!
//! [`IdMap`] knows where each message is now (folder, UIDVALIDITY, UID),
//! filled by every listing and moved along with the messages; it lives in
//! memory only, so after a restart an `l:` id is found from its own text
//! (where it was first seen), and `e:`/`g:` ids by searching for them.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;

use super::error::MailServerError;
use super::session::Capabilities;

/// The view of flagged mail.
pub const FLAGGED: &str = "v:flagged";
/// The view of all mail (every folder but Trash and Junk).
pub const ALL: &str = "v:all";

/// How many message locations are kept per account (the oldest half goes beyond).
const MAX_IDS: usize = 50_000;

pub fn folder_id(path: &str) -> String {
    format!("f:{path}")
}

/// A mailbox id as what it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailboxRef {
    Folder(String),
    Flagged,
    All,
}

pub fn mailbox(id: &str) -> Result<MailboxRef, MailServerError> {
    match id {
        FLAGGED => Ok(MailboxRef::Flagged),
        ALL => Ok(MailboxRef::All),
        _ => id
            .strip_prefix("f:")
            .map(|path| MailboxRef::Folder(path.to_string()))
            .ok_or_else(|| MailServerError::not_found(format!("There's no folder {id}."))),
    }
}

/// Where a message is.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Location {
    /// The folder's path (as in its id).
    pub path: String,
    pub validity: u32,
    pub uid: u32,
}

/// The id of a message seen first at `location`, on servers without their own ids.
pub fn local_id(location: &Location) -> String {
    format!(
        "l:{}:{}:{}",
        folder_id(&location.path),
        location.validity,
        location.uid
    )
}

/// Where an `l:` id was first seen.
pub fn parse_local(id: &str) -> Option<Location> {
    let rest = id.strip_prefix("l:f:")?;
    let (rest, uid) = rest.rsplit_once(':')?;
    let (path, validity) = rest.rsplit_once(':')?;
    Some(Location {
        path: path.to_string(),
        validity: validity.parse().ok()?,
        uid: uid.parse().ok()?,
    })
}

/// Which ids a server's messages get.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// EMAILID and THREADID (OBJECTID).
    ObjectId,
    /// X-GM-MSGID and X-GM-THRID.
    Gmail,
    /// action0's own (`l:`).
    Local,
}

impl Scheme {
    pub fn of(capabilities: &Capabilities) -> Self {
        if capabilities.has("OBJECTID") {
            Self::ObjectId
        } else if capabilities.has("X-GM-EXT-1") {
            Self::Gmail
        } else {
            Self::Local
        }
    }

    /// What a FETCH asks for besides the rest (with a leading space).
    pub fn fetch_items(self) -> &'static str {
        match self {
            Self::ObjectId => " EMAILID THREADID",
            Self::Gmail => " X-GM-MSGID X-GM-THRID",
            Self::Local => "",
        }
    }
}

/// The server's own ids of a message (from a FETCH).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServerIds {
    pub email_id: Option<String>,
    pub thread_id: Option<String>,
    pub gm_msgid: Option<u64>,
    pub gm_thrid: Option<u64>,
}

impl ServerIds {
    /// The message id the server gives, if it gives one.
    pub fn message_id(&self) -> Option<String> {
        match (&self.email_id, self.gm_msgid) {
            (Some(id), _) => Some(format!("e:{id}")),
            (None, Some(id)) => Some(format!("g:{id}")),
            _ => None,
        }
    }

    /// The thread key the server gives, if it gives one.
    pub fn thread_id(&self) -> Option<String> {
        match (&self.thread_id, self.gm_thrid) {
            (Some(id), _) => Some(format!("t:{id}")),
            (None, Some(id)) => Some(format!("g:{id}")),
            _ => None,
        }
    }
}

/// Where each message is (by id), and which id each location has.
#[derive(Debug, Default)]
pub struct IdMap {
    by_id: HashMap<String, (Location, u64)>,
    by_location: HashMap<Location, String>,
    tick: u64,
}

impl IdMap {
    pub fn get(&self, id: &str) -> Option<&Location> {
        self.by_id.get(id).map(|(location, _)| location)
    }

    /// The id of the message at `location`: the server's, else the one it
    /// had where action0 saw it first (it may have moved there), else a new one.
    pub fn identify(&mut self, location: &Location, server: &ServerIds) -> String {
        let id = server.message_id().unwrap_or_else(|| {
            self.by_location
                .get(location)
                .cloned()
                .unwrap_or_else(|| local_id(location))
        });
        self.put(&id, location.clone());
        id
    }

    /// The id the message at `location` is known by, if any (also after it's gone).
    pub fn known_at(&self, location: &Location) -> Option<&str> {
        self.by_location.get(location).map(String::as_str)
    }

    /// Notes that message `id` is at `location` now.
    pub fn put(&mut self, id: &str, location: Location) {
        if let Some((old, _)) = self.by_id.remove(id) {
            self.by_location.remove(&old);
        }
        if let Some(other) = self.by_location.insert(location.clone(), id.to_string())
            && other != id
        {
            self.by_id.remove(&other);
        }
        self.tick += 1;
        self.by_id.insert(id.to_string(), (location, self.tick));
        if self.by_id.len() > MAX_IDS {
            self.trim();
        }
    }

    /// Forgets a message (it was deleted).
    pub fn remove(&mut self, id: &str) {
        if let Some((location, _)) = self.by_id.remove(id) {
            self.by_location.remove(&location);
        }
    }

    /// A folder was renamed (its subfolders with it).
    pub fn rename_folder(&mut self, from: &str, to: &str, delimiter: Option<char>) {
        let moved = |path: &str| -> Option<String> {
            if path == from {
                return Some(to.to_string());
            }
            let delimiter = delimiter?;
            path.strip_prefix(from)
                .and_then(|rest| rest.strip_prefix(delimiter))
                .map(|rest| format!("{to}{delimiter}{rest}"))
        };
        let entries: Vec<(String, Location, u64)> = self
            .by_id
            .iter()
            .filter(|(_, (location, _))| moved(&location.path).is_some())
            .map(|(id, (location, tick))| (id.clone(), location.clone(), *tick))
            .collect();
        for (id, location, tick) in entries {
            self.by_location.remove(&location);
            let location = Location {
                path: moved(&location.path).expect("filtered"),
                ..location
            };
            self.by_location.insert(location.clone(), id.clone());
            self.by_id.insert(id, (location, tick));
        }
    }

    /// Drops the older half.
    fn trim(&mut self) {
        let mut ticks: Vec<u64> = self.by_id.values().map(|(_, tick)| *tick).collect();
        ticks.sort_unstable();
        let keep_from = ticks[ticks.len() / 2];
        let by_location = &mut self.by_location;
        self.by_id.retain(|_, (location, tick)| {
            let keep = *tick >= keep_from;
            if !keep {
                by_location.remove(location);
            }
            keep
        });
    }
}

/// A folder name in modified UTF-7 (RFC 3501 5.1.3), as servers without
/// UTF8=ACCEPT want them.
pub fn encode_mutf7(text: &str) -> String {
    fn flush(out: &mut String, pending: &mut Vec<u16>) {
        if pending.is_empty() {
            return;
        }
        let bytes: Vec<u8> = pending.iter().flat_map(|unit| unit.to_be_bytes()).collect();
        out.push('&');
        out.push_str(&STANDARD_NO_PAD.encode(bytes).replace('/', ","));
        out.push('-');
        pending.clear();
    }
    let mut out = String::with_capacity(text.len());
    let mut pending = Vec::new();
    for c in text.chars() {
        if (' '..='~').contains(&c) {
            flush(&mut out, &mut pending);
            if c == '&' {
                out.push_str("&-");
            } else {
                out.push(c);
            }
        } else {
            let mut units = [0u16; 2];
            pending.extend_from_slice(c.encode_utf16(&mut units));
        }
    }
    flush(&mut out, &mut pending);
    out
}

/// A folder name from modified UTF-7; `None` if it isn't (then it's kept as it is).
pub fn decode_mutf7(text: &str) -> Option<String> {
    if !text.is_ascii() {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('-')?;
        let encoded = &after[..end];
        if encoded.is_empty() {
            out.push('&');
        } else {
            let bytes = STANDARD_NO_PAD.decode(encoded.replace(',', "/")).ok()?;
            if bytes.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = bytes
                .chunks(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            out.push_str(&String::from_utf16(&units).ok()?);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_modified_utf7() {
        for (plain, encoded) in [
            ("Entwürfe", "Entw&APw-rfe"),
            ("Gelöschte Elemente", "Gel&APY-schte Elemente"),
            ("Tom & Jerry", "Tom &- Jerry"),
            ("日本語", "&ZeVnLIqe-"),
            ("INBOX", "INBOX"),
            ("😀", "&2D3eAA-"),
        ] {
            assert_eq!(encode_mutf7(plain), encoded, "{plain}");
            assert_eq!(decode_mutf7(encoded).as_deref(), Some(plain), "{encoded}");
        }
        assert_eq!(decode_mutf7("A&B"), None);
        assert_eq!(decode_mutf7("Grüße"), None);
    }

    #[test]
    fn reads_ids() {
        let location = Location {
            path: "Archiv:2026".into(),
            validity: 7,
            uid: 42,
        };
        let id = local_id(&location);
        assert_eq!(id, "l:f:Archiv:2026:7:42");
        assert_eq!(parse_local(&id), Some(location));
        assert_eq!(parse_local("e:abc"), None);
        assert_eq!(
            mailbox("f:INBOX").unwrap(),
            MailboxRef::Folder("INBOX".into())
        );
        assert_eq!(mailbox(FLAGGED).unwrap(), MailboxRef::Flagged);
        assert!(mailbox("x").is_err());
    }

    #[test]
    fn keeps_ids_of_messages_that_moved() {
        let mut ids = IdMap::default();
        let inbox = Location {
            path: "INBOX".into(),
            validity: 1,
            uid: 5,
        };
        let id = ids.identify(&inbox, &ServerIds::default());
        assert_eq!(id, "l:f:INBOX:1:5");
        let archive = Location {
            path: "Archive".into(),
            validity: 3,
            uid: 9,
        };
        ids.put(&id, archive.clone());
        // Listed in Archive: the same id.
        assert_eq!(ids.identify(&archive, &ServerIds::default()), id);
        assert_eq!(ids.known_at(&inbox), None);
        // The server's ids win.
        let server = ServerIds {
            email_id: Some("M1".into()),
            ..ServerIds::default()
        };
        assert_eq!(ids.identify(&inbox, &server), "e:M1");

        ids.rename_folder("Archive", "Old/Archive", Some('/'));
        assert_eq!(ids.get(&id).unwrap().path, "Old/Archive");
        ids.remove(&id);
        assert_eq!(ids.get(&id), None);
    }

    #[test]
    fn forgets_the_oldest_beyond_its_limit() {
        let mut ids = IdMap::default();
        for uid in 0..=MAX_IDS as u32 {
            let location = Location {
                path: "INBOX".into(),
                validity: 1,
                uid,
            };
            ids.identify(&location, &ServerIds::default());
        }
        assert!(ids.by_id.len() <= MAX_IDS / 2 + 1);
        assert_eq!(ids.by_id.len(), ids.by_location.len());
        assert!(ids.get(&format!("l:f:INBOX:1:{MAX_IDS}")).is_some());
        assert!(ids.get("l:f:INBOX:1:0").is_none());
    }
}
