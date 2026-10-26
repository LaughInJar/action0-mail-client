//! Reading mail with mail-parser: list rows' header fields, whole messages
//! as the UI's `ImapMessage` (bodies raw, attachments by MIME part path),
//! one part's bytes for `imap_bytes`, and a small cache of whole messages
//! so opening a message and then its attachments fetches it once.

use std::collections::VecDeque;
use std::sync::Arc;

use mail_parser::{AddressList, Headers, MessageParser, MessagePart, PartKind, preview_text};

use super::ids::{ServerIds, folder_id};
use super::model::{Address, Attachment, Body, Flags, Message, Summary};
use super::proto::iso;

/// How long a snippet may be (characters).
pub const SNIPPET_LENGTH: usize = 200;
/// Whole messages kept in memory per account, and their bytes at most.
const CACHED_MESSAGES: usize = 20;
const CACHED_BYTES: usize = 50 * 1024 * 1024;

/// What a message's header says, decoded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HeaderInfo {
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    /// With angle brackets.
    pub message_id: Option<String>,
    /// Oldest first, with angle brackets.
    pub references: Vec<String>,
    pub in_reply_to: Option<String>,
    /// `type/subtype`, lower case.
    pub content_type: Option<String>,
}

impl HeaderInfo {
    /// Reads a header block (a whole message works too).
    pub fn read(header: &[u8]) -> Self {
        MessageParser::new()
            .parse_headers(header)
            .map(|message| Self::of(&message.headers()))
            .unwrap_or_default()
    }

    fn of(headers: &Headers<'_>) -> Self {
        let bracketed = |id: &str| format!("<{}>", id.trim_matches(|c| c == '<' || c == '>'));
        Self {
            from: headers
                .from()
                .and_then(|list| addresses(&list).into_iter().next()),
            to: headers
                .to()
                .map(|list| addresses(&list))
                .unwrap_or_default(),
            cc: headers
                .cc()
                .map(|list| addresses(&list))
                .unwrap_or_default(),
            bcc: headers
                .bcc()
                .map(|list| addresses(&list))
                .unwrap_or_default(),
            reply_to: headers
                .reply_to()
                .map(|list| addresses(&list))
                .unwrap_or_default(),
            subject: headers.subject().unwrap_or_default().trim().to_string(),
            message_id: headers
                .message_id()
                .filter(|id| !id.is_empty())
                .map(bracketed),
            references: headers
                .references()
                .map(|list| list.iter().map(bracketed).collect())
                .unwrap_or_default(),
            in_reply_to: headers
                .in_reply_to()
                .and_then(|list| list.first().map(bracketed)),
            content_type: headers.value("Content-Type").and_then(|value| {
                let content = value.as_content_type()?;
                Some(
                    format!(
                        "{}/{}",
                        content.ctype(),
                        content.subtype().unwrap_or_default()
                    )
                    .to_ascii_lowercase(),
                )
            }),
        }
    }
}

fn addresses(list: &AddressList<'_>) -> Vec<Address> {
    list.mailboxes()
        .filter_map(|mailbox| {
            let address = mailbox.address()?.trim();
            (!address.is_empty()).then(|| Address {
                name: mailbox
                    .name()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                address: address.to_string(),
            })
        })
        .collect()
}

/// The thread key: the server's thread id, else the first Message-ID of the
/// References (else In-Reply-To, else the message's own); `m:<id>` for a
/// message without any.
pub fn thread_key(server: &ServerIds, info: &HeaderInfo, id: &str) -> String {
    server
        .thread_id()
        .or_else(|| info.references.first().cloned())
        .or_else(|| info.in_reply_to.clone())
        .or_else(|| info.message_id.clone())
        .unwrap_or_else(|| format!("m:{id}"))
}

/// Text on one line, at most [`SNIPPET_LENGTH`] characters.
pub fn one_line(text: &str) -> String {
    let text = text.trim_end_matches('\u{FFFD}');
    let mut out = String::with_capacity(text.len().min(SNIPPET_LENGTH * 4));
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() > SNIPPET_LENGTH {
            break;
        }
    }
    match out.char_indices().nth(SNIPPET_LENGTH) {
        Some((end, _)) => out[..end].to_string(),
        None => out,
    }
}

/// Tags that don't end a line of text.
const INLINE_TAGS: &[&str] = &[
    "a", "abbr", "b", "big", "cite", "code", "em", "font", "i", "img", "kbd", "label", "mark", "q",
    "s", "small", "span", "strike", "strong", "sub", "sup", "tt", "u", "var", "wbr",
];

/// HTML with a space before block tags, so text from separate blocks
/// (`<h1>Hello</h1><p>World`) doesn't run together in a preview.
fn separate_blocks(html: &str) -> String {
    let mut out = String::with_capacity(html.len() + html.len() / 16);
    let mut rest = html;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tag = &rest[at + 1..];
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase();
        if !name.is_empty() && !INLINE_TAGS.contains(&name.as_str()) {
            out.push(' ');
        }
        out.push('<');
        rest = tag;
    }
    out.push_str(rest);
    out
}

/// A preview of HTML: its text, on one line.
fn html_preview(html: &str) -> String {
    one_line(&mail_parser::preview_html(
        &separate_blocks(html),
        SNIPPET_LENGTH * 4,
    ))
}

/// A preview of a message's body: its first text body part.
fn body_preview(message: &mail_parser::Message<'_>) -> String {
    let Some(part) = message.root().text_body().next() else {
        return String::new();
    };
    let text = part.text().unwrap_or_default();
    match part.kind() {
        PartKind::Html => html_preview(&text),
        _ => one_line(&preview_text(&text, SNIPPET_LENGTH * 4)),
    }
}

/// What a whole message's row needs besides its bytes.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub id: String,
    pub folder: String,
    pub seen: bool,
    pub flagged: bool,
    pub draft: bool,
    /// INTERNALDATE, ms since 1970.
    pub date: i64,
    pub server: ServerIds,
}

/// The MIME parts of a message's own tree (not inside attached messages)
/// by their IMAP path: "1" for a message that isn't multipart.
fn part_paths(message: &mail_parser::Message<'_>) -> Vec<(u32, String)> {
    fn walk(part: MessagePart<'_>, path: String, out: &mut Vec<(u32, String)>) {
        if part.is_multipart() {
            for (index, child) in part.children().enumerate() {
                let child_path = if path.is_empty() {
                    (index + 1).to_string()
                } else {
                    format!("{path}.{}", index + 1)
                };
                walk(child, child_path, out);
            }
        } else {
            out.push((part.id(), if path.is_empty() { "1".into() } else { path }));
        }
    }
    let mut out = Vec::new();
    walk(message.root_part(), String::new(), &mut out);
    out
}

/// A body part (shown as the text), not something attached.
fn is_body(part: &MessagePart<'_>) -> bool {
    matches!(part.kind(), PartKind::Text | PartKind::Html)
        && (part.in_text_body() || part.in_html_body())
        && !part.is_attachment()
}

fn mime_type(part: &MessagePart<'_>) -> String {
    part.content_type()
        .map(|content| {
            format!(
                "{}/{}",
                content.ctype(),
                content.subtype().unwrap_or("octet-stream")
            )
            .to_ascii_lowercase()
        })
        .unwrap_or_else(|| match part.kind() {
            PartKind::Text => "text/plain".into(),
            _ => "application/octet-stream".into(),
        })
}

/// A whole message as the UI's `ImapMessage`.
pub fn message(raw: &[u8], meta: &Meta) -> Message {
    let Some(parsed) = MessageParser::new().parse(raw) else {
        return empty_message(meta);
    };
    let info = HeaderInfo::of(&parsed.headers());
    let root = parsed.root();

    let html: Vec<String> = root
        .html_body()
        .filter(|part| matches!(part.kind(), PartKind::Html))
        .filter_map(|part| part.html_utf8().map(|html| html.into_owned()))
        .collect();
    let text: Vec<String> = root
        .text_body()
        .filter(|part| matches!(part.kind(), PartKind::Text))
        .filter_map(|part| part.text().map(|text| text.into_owned()))
        .collect();

    let mut attachments = Vec::new();
    let mut calendar = None;
    for (id, path) in part_paths(&parsed) {
        let Some(part) = parsed.part(id) else {
            continue;
        };
        if calendar.is_none() && part.is_content_type("text", "calendar") {
            calendar = part.text().map(|text| text.into_owned());
        }
        if is_body(&part) {
            continue;
        }
        let content_id = part
            .content_id()
            .map(|id| id.trim_matches(|c| c == '<' || c == '>').to_string())
            .filter(|id| !id.is_empty());
        let filename = part
            .attachment_name()
            .map(str::to_string)
            .filter(|name| !name.trim().is_empty())
            .or_else(|| {
                part.nested()
                    .and_then(|nested| nested.subject().map(|subject| format!("{subject}.eml")))
            })
            .or_else(|| content_id.clone())
            .unwrap_or_else(|| "attachment".into());
        attachments.push(Attachment {
            id: path,
            filename,
            mime_type: mime_type(&part),
            size: part.decoded_len() as u64,
            content_id,
        });
    }
    let has_attachments = attachments
        .iter()
        .any(|a| a.content_id.is_none() || !a.mime_type.starts_with("image/"));
    let snippet = body_preview(&parsed);
    let header = |name: &str| {
        parsed.headers().get(name).map(|header| {
            let value = String::from_utf8_lossy(header.raw_value());
            value.split_whitespace().collect::<Vec<_>>().join(" ")
        })
    };

    Message {
        summary: Summary {
            id: meta.id.clone(),
            thread_id: thread_key(&meta.server, &info, &meta.id),
            mailbox_ids: vec![folder_id(&meta.folder)],
            from: info.from.clone(),
            to: info.to.clone(),
            subject: info.subject.clone(),
            snippet,
            received_at: iso(meta.date),
            flags: Flags {
                seen: meta.seen,
                flagged: meta.flagged,
            },
            has_attachments,
        },
        cc: info.cc,
        bcc: info.bcc,
        reply_to: info.reply_to,
        internet_message_id: info.message_id,
        references: info.references,
        in_reply_to: info.in_reply_to,
        body: Body {
            html: (!html.is_empty()).then(|| html.join("\n")),
            text: (!text.is_empty()).then(|| text.join("\n")),
        },
        attachments,
        list_unsubscribe: header("List-Unsubscribe"),
        list_unsubscribe_post: header("List-Unsubscribe-Post"),
        calendar,
        draft: meta.draft,
    }
}

/// A message that couldn't be read at all: its row, with the raw text.
fn empty_message(meta: &Meta) -> Message {
    Message {
        summary: Summary {
            id: meta.id.clone(),
            thread_id: format!("m:{}", meta.id),
            mailbox_ids: vec![folder_id(&meta.folder)],
            from: None,
            to: Vec::new(),
            subject: String::new(),
            snippet: String::new(),
            received_at: iso(meta.date),
            flags: Flags {
                seen: meta.seen,
                flagged: meta.flagged,
            },
            has_attachments: false,
        },
        cc: Vec::new(),
        bcc: Vec::new(),
        reply_to: Vec::new(),
        internet_message_id: None,
        references: Vec::new(),
        in_reply_to: None,
        body: Body::default(),
        attachments: Vec::new(),
        list_unsubscribe: None,
        list_unsubscribe_post: None,
        calendar: None,
        draft: meta.draft,
    }
}

/// The decoded bytes of the part at `path` ("2", "1.3"); an attached
/// message comes as it is (.eml).
pub fn part(raw: &[u8], path: &str) -> Option<Vec<u8>> {
    let parsed = MessageParser::new().parse(raw)?;
    let (id, _) = part_paths(&parsed)
        .into_iter()
        .find(|(_, candidate)| candidate == path)?;
    Some(parsed.part(id)?.decoded().into_owned())
}

/// A preview of the start of a body part: `bytes` as fetched (still
/// transfer-encoded, cut anywhere), with its type, charset and encoding.
pub fn snippet(bytes: &[u8], html: bool, charset: Option<&str>, encoding: &str) -> String {
    let mut message = format!(
        "Content-Type: text/{}; charset=\"{}\"\r\nContent-Transfer-Encoding: {}\r\n\r\n",
        if html { "html" } else { "plain" },
        charset.unwrap_or("utf-8").replace('"', ""),
        encoding
    )
    .into_bytes();
    message.extend_from_slice(bytes);
    let Some(parsed) = MessageParser::new().parse(&message) else {
        return String::new();
    };
    let Some(text) = parsed.root_part().text() else {
        return String::new();
    };
    if html {
        html_preview(&text)
    } else {
        one_line(&preview_text(&text, SNIPPET_LENGTH * 4))
    }
}

/// A preview from a header block and the start of the body after it.
pub fn snippet_after(header: &[u8], body: &[u8]) -> String {
    let mut message = header.to_vec();
    if !message.ends_with(b"\r\n\r\n") && !message.ends_with(b"\n\n") {
        message.extend_from_slice(b"\r\n");
    }
    message.extend_from_slice(body);
    MessageParser::new()
        .parse(&message)
        .map(|parsed| body_preview(&parsed))
        .unwrap_or_default()
}

/// The last whole messages opened, by message id (they don't change).
#[derive(Debug, Default)]
pub struct RawCache {
    entries: VecDeque<(String, Arc<Vec<u8>>)>,
    bytes: usize,
}

impl RawCache {
    pub fn get(&mut self, id: &str) -> Option<Arc<Vec<u8>>> {
        let index = self.entries.iter().position(|(key, _)| key == id)?;
        let entry = self.entries.remove(index)?;
        let raw = entry.1.clone();
        self.entries.push_back(entry);
        Some(raw)
    }

    pub fn put(&mut self, id: &str, raw: Arc<Vec<u8>>) {
        self.remove(id);
        if raw.len() > CACHED_BYTES {
            return;
        }
        self.bytes += raw.len();
        self.entries.push_back((id.to_string(), raw));
        while self.entries.len() > CACHED_MESSAGES || self.bytes > CACHED_BYTES {
            match self.entries.pop_front() {
                Some((_, raw)) => self.bytes -= raw.len(),
                None => break,
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(index) = self.entries.iter().position(|(key, _)| key == id)
            && let Some((_, raw)) = self.entries.remove(index)
        {
            self.bytes -= raw.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta {
            id: "l:f:INBOX:1:7".into(),
            folder: "INBOX".into(),
            seen: true,
            flagged: false,
            draft: false,
            date: 1_792_000_000_000,
            server: ServerIds::default(),
        }
    }

    #[test]
    fn reads_an_alternative_with_an_inline_image_and_an_attachment() {
        let raw = concat!(
            "From: =?UTF-8?Q?Anna_M=C3=BCller?= <anna@example.org>\r\n",
            "To: Max <max@example.com>, team: bob@example.com, cy@example.com;\r\n",
            "Cc: <dora@example.com>\r\n",
            "Subject: =?ISO-8859-1?Q?Gr=FC=DFe?= aus Wien\r\n",
            "Message-ID: <m2@example.org>\r\n",
            "In-Reply-To: <m1@example.org>\r\n",
            "References: <m0@example.org> <m1@example.org>\r\n",
            "List-Unsubscribe: <https://example.org/u?x=1>,\r\n <mailto:u@example.org>\r\n",
            "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=\"outer\"\r\n",
            "\r\n",
            "--outer\r\n",
            "Content-Type: multipart/related; boundary=\"rel\"\r\n",
            "\r\n",
            "--rel\r\n",
            "Content-Type: multipart/alternative; boundary=\"alt\"\r\n",
            "\r\n",
            "--alt\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "Hallo Max,\r\nwie geht's?\r\n",
            "--alt\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "\r\n",
            "<p>Hallo Max,</p><img src=\"cid:logo@x\">\r\n",
            "--alt--\r\n",
            "--rel\r\n",
            "Content-Type: image/png\r\n",
            "Content-ID: <logo@x>\r\n",
            "Content-Transfer-Encoding: base64\r\n",
            "\r\n",
            "iVBORw0KGgo=\r\n",
            "--rel--\r\n",
            "--outer\r\n",
            "Content-Type: application/pdf\r\n",
            "Content-Disposition: attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf\r\n",
            "Content-Transfer-Encoding: base64\r\n",
            "\r\n",
            "JVBERi0xLjQK\r\n",
            "--outer--\r\n",
        );
        let message = message(raw.as_bytes(), &meta());
        let summary = &message.summary;
        assert_eq!(
            summary.from,
            Some(Address {
                name: Some("Anna Müller".into()),
                address: "anna@example.org".into()
            })
        );
        let to: Vec<&str> = summary.to.iter().map(|a| a.address.as_str()).collect();
        assert_eq!(to, ["max@example.com", "bob@example.com", "cy@example.com"]);
        assert_eq!(message.cc[0].address, "dora@example.com");
        assert_eq!(summary.subject, "Grüße aus Wien");
        assert_eq!(summary.thread_id, "<m0@example.org>");
        assert_eq!(summary.received_at, "2026-10-14T17:46:40Z");
        assert_eq!(summary.snippet, "Hallo Max, wie geht's?");
        assert!(summary.has_attachments);
        assert_eq!(
            message.internet_message_id.as_deref(),
            Some("<m2@example.org>")
        );
        assert_eq!(message.references, ["<m0@example.org>", "<m1@example.org>"]);
        assert_eq!(message.in_reply_to.as_deref(), Some("<m1@example.org>"));
        assert_eq!(
            message.body.text.as_deref(),
            Some("Hallo Max,\r\nwie geht's?")
        );
        assert!(message.body.html.as_deref().unwrap().contains("cid:logo@x"));
        assert_eq!(
            message.list_unsubscribe.as_deref(),
            Some("<https://example.org/u?x=1>, <mailto:u@example.org>")
        );
        assert_eq!(
            message.list_unsubscribe_post.as_deref(),
            Some("List-Unsubscribe=One-Click")
        );
        assert_eq!(
            message.attachments,
            vec![
                Attachment {
                    id: "1.2".into(),
                    filename: "logo@x".into(),
                    mime_type: "image/png".into(),
                    size: 8,
                    content_id: Some("logo@x".into()),
                },
                Attachment {
                    id: "2".into(),
                    filename: "Rechnung März.pdf".into(),
                    mime_type: "application/pdf".into(),
                    size: 9,
                    content_id: None,
                },
            ]
        );
        assert_eq!(part(raw.as_bytes(), "2").unwrap(), b"%PDF-1.4\n");
        assert_eq!(
            part(raw.as_bytes(), "1.1.1").unwrap(),
            b"Hallo Max,\r\nwie geht's?"
        );
        assert_eq!(part(raw.as_bytes(), "9"), None);
    }

    #[test]
    fn reads_a_latin1_body_and_an_invitation() {
        let raw = concat!(
            "From: bob@example.org\r\n",
            "Subject: Termin\r\n",
            "Content-Type: multipart/alternative; boundary=b\r\n",
            "\r\n",
            "--b\r\n",
            "Content-Type: text/plain; charset=ISO-8859-1\r\n",
            "Content-Transfer-Encoding: quoted-printable\r\n",
            "\r\n",
            "Gr=FC=DF Gott\r\n",
            "--b\r\n",
            "Content-Type: text/calendar; method=REQUEST; charset=utf-8\r\n",
            "\r\n",
            "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n",
            "--b--\r\n",
        );
        let message = message(raw.as_bytes(), &meta());
        assert_eq!(message.body.text.as_deref(), Some("Grüß Gott"));
        assert_eq!(message.body.html, None);
        assert!(
            message
                .calendar
                .as_deref()
                .unwrap()
                .contains("METHOD:REQUEST")
        );
        // No References or In-Reply-To, no Message-ID: its own key.
        assert_eq!(message.summary.thread_id, "m:l:f:INBOX:1:7");
        assert_eq!(message.summary.from.as_ref().unwrap().name, None);
    }

    #[test]
    fn a_single_part_message_is_part_one() {
        let raw = b"Subject: x\r\nContent-Type: text/plain\r\n\r\nHello\r\n";
        assert_eq!(part(raw, "1").unwrap(), b"Hello\r\n");
        let message = message(raw, &meta());
        assert!(message.attachments.is_empty());
        assert!(!message.summary.has_attachments);
    }

    #[test]
    fn previews_the_start_of_a_part() {
        // Base64 cut in the middle, and HTML.
        let encoded = "PGgxPkhlbGxvPC9oMT48cD5Xb3JsZCAmYW1wOyBtb3JlPC9wPg==";
        assert_eq!(
            snippet(&encoded.as_bytes()[..40], true, Some("utf-8"), "base64"),
            "Hello World & m"
        );
        assert_eq!(
            snippet(
                b"Gr=FC=DF   Gott\r\nund",
                false,
                Some("iso-8859-1"),
                "quoted-printable"
            ),
            "Grüß Gott und"
        );
        assert_eq!(
            one_line(&"word ".repeat(100)).chars().count(),
            SNIPPET_LENGTH
        );
        assert_eq!(
            snippet_after(b"Content-Type: text/plain\r\n\r\n", b"Hi there"),
            "Hi there"
        );
    }

    #[test]
    fn reads_header_fields() {
        let info = HeaderInfo::read(
            b"From: \"Berger, Anna\" <anna@example.org>\r\nSubject: =?UTF-8?B?w4RyZ2Vy?=\r\nContent-Type: Multipart/Mixed; boundary=x\r\n\r\n",
        );
        assert_eq!(info.from.unwrap().name.as_deref(), Some("Berger, Anna"));
        assert_eq!(info.subject, "Ärger");
        assert_eq!(info.content_type.as_deref(), Some("multipart/mixed"));
    }

    #[test]
    fn keeps_the_last_messages() {
        let mut cache = RawCache::default();
        for n in 0..25 {
            cache.put(&n.to_string(), Arc::new(vec![0; 10]));
        }
        assert!(cache.get("0").is_none());
        assert!(cache.get("24").is_some());
        assert_eq!(cache.bytes, 200);
        cache.put("big", Arc::new(vec![0; CACHED_BYTES - 5]));
        assert_eq!(cache.entries.len(), 1);
        cache.remove("big");
        assert_eq!(cache.bytes, 0);
    }
}
