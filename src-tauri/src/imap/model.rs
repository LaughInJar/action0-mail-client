//! The JSON of `imap_call`, `imap_bytes` and `imap_append`: the shapes of
//! `src/providers/imap/bridge.ts` (camelCase, absent fields left out).

use serde::{Deserialize, Deserializer, Serialize};

/// A folder or view (`ImapMailbox`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailbox {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub kind: MailboxKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    pub selectable: bool,
    pub hidden: bool,
    pub assignable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<Counts>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MailboxKind {
    Folder,
    View,
}

/// What a folder is for (special use, else its name).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Inbox,
    Flagged,
    Sent,
    Drafts,
    All,
    Archive,
    Junk,
    Trash,
}

impl Role {
    /// The order of `MAILBOX_ROLE_ORDER` in `src/core/model.ts`.
    pub fn rank(self) -> u8 {
        match self {
            Self::Inbox => 0,
            Self::Flagged => 1,
            Self::Sent => 3,
            Self::Drafts => 4,
            Self::All => 5,
            Self::Archive => 6,
            Self::Junk => 7,
            Self::Trash => 8,
        }
    }

    /// The special-use attribute (RFC 6154) for creating such a folder.
    pub fn attribute(self) -> Option<&'static str> {
        match self {
            Self::Inbox => None,
            Self::Flagged => Some("\\Flagged"),
            Self::Sent => Some("\\Sent"),
            Self::Drafts => Some("\\Drafts"),
            Self::All => Some("\\All"),
            Self::Archive => Some("\\Archive"),
            Self::Junk => Some("\\Junk"),
            Self::Trash => Some("\\Trash"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub unread: u32,
    pub total: u32,
}

/// An address of an address header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Address {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub address: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Flags {
    pub seen: bool,
    pub flagged: bool,
}

/// A message as a list row (`ImapSummary`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub thread_id: String,
    pub mailbox_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    /// ISO 8601.
    pub received_at: String,
    pub flags: Flags,
    pub has_attachments: bool,
}

/// A conversation (`ImapThread`): messages oldest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Thread {
    pub id: String,
    pub messages: Vec<Summary>,
}

/// A file or inline part (`ImapAttachment`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// The MIME part's path ("2", "1.3").
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Body {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// A whole message (`ImapMessage`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(flatten)]
    pub summary: Summary,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internet_message_id: Option<String>,
    pub references: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    pub body: Body,
    pub attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_unsubscribe_post: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar: Option<String>,
    pub draft: bool,
}

/// A page of a list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// One change (`ImapChange`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    Added { message: Summary },
    Updated { message: Summary },
    Removed { id: String },
}

/// What `changes` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Changes {
    pub token: String,
    pub reset: bool,
    pub changes: Vec<Change>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    #[default]
    Newest,
    Oldest,
}

/// What a list asks for (`ImapListQuery`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub mailbox_id: String,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub order: Option<Order>,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct IdRequest {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct IdsRequest {
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FlagsRequest {
    pub ids: Vec<String>,
    #[serde(default)]
    pub seen: Option<bool>,
    #[serde(default)]
    pub flagged: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MoveRequest {
    pub ids: Vec<String>,
    pub to: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxRequest {
    pub mailbox_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolder {
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub role: Option<Role>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolder {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Absent: stays; `null`: to the top level.
    #[serde(default, deserialize_with = "present")]
    pub parent_id: Option<Option<String>>,
}

/// A field that's there (even as `null`) becomes `Some`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ChangesRequest {
    #[serde(default)]
    pub token: Option<String>,
}

/// What `imap_bytes` fetches (`ImapBytesRequest`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BytesRequest {
    Raw { id: String },
    Part { id: String, part: String },
}

/// What `imap_append` gets besides the message.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMeta {
    pub key: String,
    pub mailbox_id: String,
    #[serde(default)]
    pub flags: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_the_bridges_shapes() {
        let summary = Summary {
            id: "l:f:INBOX:1:2".into(),
            thread_id: "<a@b>".into(),
            mailbox_ids: vec!["f:INBOX".into()],
            from: None,
            to: vec![Address {
                name: None,
                address: "me@example.org".into(),
            }],
            subject: "Hi".into(),
            snippet: "".into(),
            received_at: "2026-10-18T10:00:00Z".into(),
            flags: Flags::default(),
            has_attachments: false,
        };
        let json = serde_json::to_value(Change::Updated {
            message: summary.clone(),
        })
        .unwrap();
        assert_eq!(json["kind"], "updated");
        assert_eq!(json["message"]["threadId"], "<a@b>");
        assert_eq!(json["message"]["mailboxIds"][0], "f:INBOX");
        assert!(json["message"].get("from").is_none());
        let message = Message {
            summary,
            cc: vec![],
            bcc: vec![],
            reply_to: vec![],
            internet_message_id: Some("<a@b>".into()),
            references: vec![],
            in_reply_to: None,
            body: Body {
                html: None,
                text: Some("Hi".into()),
            },
            attachments: vec![],
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            calendar: None,
            draft: false,
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["receivedAt"], "2026-10-18T10:00:00Z");
        assert_eq!(json["internetMessageId"], "<a@b>");
        assert_eq!(json["body"], serde_json::json!({"text": "Hi"}));
        assert_eq!(
            serde_json::to_value(Change::Removed { id: "x".into() }).unwrap(),
            serde_json::json!({"kind": "removed", "id": "x"})
        );
    }

    #[test]
    fn reads_requests() {
        let update: UpdateFolder = serde_json::from_str(r#"{"id":"f:a","parentId":null}"#).unwrap();
        assert_eq!(update.parent_id, Some(None));
        let update: UpdateFolder = serde_json::from_str(r#"{"id":"f:a","name":"b"}"#).unwrap();
        assert_eq!(update.parent_id, None);
        let bytes: BytesRequest =
            serde_json::from_str(r#"{"kind":"part","id":"e:1","part":"1.2"}"#).unwrap();
        assert_eq!(
            bytes,
            BytesRequest::Part {
                id: "e:1".into(),
                part: "1.2".into()
            }
        );
        let query: ListQuery =
            serde_json::from_str(r#"{"mailboxId":"v:all","order":"oldest","limit":50}"#).unwrap();
        assert_eq!(query.order, Some(Order::Oldest));
    }
}
