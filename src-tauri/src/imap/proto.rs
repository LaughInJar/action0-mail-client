//! Commands the mail operations send, and their answers read one by one.
//!
//! async-imap's own commands cover the common cases, but drop what this
//! side needs: EMAILID, THREADID and X-GM-THRID in FETCH answers, the
//! APPENDUID and COPYUID codes, SORT, VANISHED, and strings that need
//! literals (non-ASCII search words without UTF8=ACCEPT, the message of an
//! APPEND). [`run`] sends a [`Command`] (waiting for the server's go-ahead
//! before each synchronizing literal) and hands every answer to a callback
//! as imap-proto parsed it.
//!
//! An answer imap-proto can't parse leaves the connection unusable: it comes
//! back as `unreachable` with [`UNREADABLE`] in the message (no mail
//! content), so the session is replaced and callers can try a simpler
//! command.

use std::time::Duration;

use async_imap::imap_proto::rfc4315::UidSetMember;
use async_imap::imap_proto::{Outcome, RequestId, Response, ResponseCode, Status};
use tokio::io::AsyncWriteExt;

use super::error::{MailServerError, answer_text};
use super::session::{ImapSession, Transport};

/// How long the server may take for one answer (a big message comes as one).
pub(crate) const ANSWER_TIMEOUT: Duration = Duration::from_secs(180);
/// Literals up to this size may go without waiting where the server has `LITERAL-`.
const LITERAL_MINUS_MAX: usize = 4096;
/// How long a command line with a UID set may get (servers limit lines; 8000 is safe).
const MAX_SET_LENGTH: usize = 4000;

/// The start of the message of an answer that couldn't be read.
pub const UNREADABLE: &str = "The server sent an answer action0 couldn't read";

/// True if `error` is an answer that couldn't be read (see the module docs).
pub fn is_unreadable(error: &MailServerError) -> bool {
    error.message.starts_with(UNREADABLE)
}

/// A piece of a command.
#[derive(Clone, Debug, PartialEq)]
enum Piece {
    /// Written as it is (atoms, numbers, parentheses, spaces).
    Text(String),
    /// A string: quoted, or a literal where quoting can't carry it.
    Str(String),
    /// Bytes, always as a literal (an APPEND's message).
    Literal(Vec<u8>),
}

/// A command: text, strings and literals, e.g. `UID SEARCH FROM "anna"`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Command(Vec<Piece>);

impl Command {
    pub fn new(text: impl Into<String>) -> Self {
        Self(vec![Piece::Text(text.into())])
    }

    /// Adds text as it is (no space is added).
    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.0.push(Piece::Text(text.into()));
        self
    }

    /// Adds a string (no space is added): quoted where that's allowed, else a literal.
    pub fn string(mut self, text: impl Into<String>) -> Self {
        self.0.push(Piece::Str(text.into()));
        self
    }

    /// Adds bytes as a literal.
    pub fn literal(mut self, bytes: Vec<u8>) -> Self {
        self.0.push(Piece::Literal(bytes));
        self
    }

    /// The command as text, for tests and errors (literals as `{n}`).
    #[cfg(test)]
    pub fn render(&self, utf8: bool) -> String {
        self.0
            .iter()
            .map(|piece| match piece {
                Piece::Text(text) => text.clone(),
                Piece::Str(text) if quotable(text, utf8) => quote(text),
                Piece::Str(text) => format!("{{{}}}", text.len()),
                Piece::Literal(bytes) => format!("{{{}}}", bytes.len()),
            })
            .collect()
    }
}

/// True if `text` can be sent as a quoted string: no line breaks or NULs,
/// and 8-bit only after `ENABLE UTF8=ACCEPT`.
pub fn quotable(text: &str, utf8: bool) -> bool {
    text.bytes()
        .all(|b| b != b'\r' && b != b'\n' && b != 0 && (utf8 || b < 0x80))
}

/// `text` as a quoted string.
pub fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The server answered NO or BAD: the error, and the response code's name
/// (`BADCHARSET`, `TRYCREATE`, …).
#[derive(Debug)]
pub struct Refusal {
    pub code: Option<String>,
    pub error: MailServerError,
}

fn refusal(outcome: &Outcome<'_>) -> Refusal {
    let detail = format!("{outcome:?}");
    let (code, _) = answer_text(&detail);
    Refusal {
        code,
        error: MailServerError::answered(&detail),
    }
}

/// Reads the next answer into `$response` (a `ResponseData`, which can't be
/// named outside async-imap, so this is a macro): within the answer timeout,
/// a closed connection or a parse failure as `unreachable`.
macro_rules! next_answer {
    ($session:expr) => {
        match tokio::time::timeout(
            $crate::imap::proto::ANSWER_TIMEOUT,
            $session.read_response(),
        )
        .await
        {
            Err(_) => Err($crate::imap::error::MailServerError::unreachable(
                "The server didn't answer in time.",
            )),
            Ok(Ok(Some(response))) => Ok(response),
            Ok(Ok(None)) => Err($crate::imap::error::MailServerError::unreachable(
                "The server closed the connection.",
            )),
            Ok(Err(error)) => Err($crate::imap::proto::read_error(error)),
        }
    };
}
pub(crate) use next_answer;

/// A failed read: a parse failure (see [`UNREADABLE`]) or a broken connection.
pub fn read_error(error: std::io::Error) -> MailServerError {
    if error.kind() == std::io::ErrorKind::Other && error.to_string().contains("during parsing") {
        return MailServerError::unreachable(format!("{UNREADABLE}."));
    }
    error.into()
}

/// Sends `command`, waiting for the go-ahead before synchronizing literals
/// (answers on the way go to `each`). Its tag, or the server's refusal.
async fn send<S, F>(
    session: &mut ImapSession<S>,
    command: &Command,
    each: &mut F,
) -> Result<Result<RequestId, Refusal>, MailServerError>
where
    S: Transport,
    F: FnMut(&Response<'_>),
{
    let utf8 = session.enabled.has("UTF8=ACCEPT");
    let plus = session.capabilities.has("LITERAL+");
    let minus = session.capabilities.has("LITERAL-");
    let mut tag: Option<RequestId> = None;
    let mut line: Vec<u8> = Vec::new();
    for piece in &command.0 {
        let bytes = match piece {
            Piece::Text(text) => {
                line.extend_from_slice(text.as_bytes());
                continue;
            }
            Piece::Str(text) if quotable(text, utf8) => {
                line.extend_from_slice(quote(text).as_bytes());
                continue;
            }
            Piece::Str(text) => text.as_bytes(),
            Piece::Literal(bytes) => bytes.as_slice(),
        };
        let waits = !(plus || (minus && bytes.len() <= LITERAL_MINUS_MAX));
        line.extend_from_slice(
            format!("{{{}{}}}", bytes.len(), if waits { "" } else { "+" }).as_bytes(),
        );
        match &tag {
            None => tag = Some(start(session, &line).await?),
            Some(_) => write_line(session, &line).await?,
        }
        line.clear();
        if waits {
            let tag = tag.as_ref().expect("sent");
            loop {
                let response = next_answer!(session)?;
                match response.parsed() {
                    Response::Continue { .. } => break,
                    Response::Done {
                        tag: done, outcome, ..
                    } if done == tag => return Ok(Err(refusal(outcome))),
                    other => each(other),
                }
            }
        }
        let stream = session.get_mut();
        stream.write_all(bytes).await?;
    }
    match tag {
        None => Ok(Ok(start(session, &line).await?)),
        Some(tag) => {
            write_line(session, &line).await?;
            Ok(Ok(tag))
        }
    }
}

/// Sends the first line of a command, with a new tag.
async fn start<S: Transport>(
    session: &mut ImapSession<S>,
    line: &[u8],
) -> Result<RequestId, MailServerError> {
    // Quoted strings are UTF-8 (or ASCII); the rest of a line is ASCII.
    let text =
        std::str::from_utf8(line).map_err(|_| MailServerError::server("A command wasn't text."))?;
    Ok(session.run_command(text).await?)
}

/// Sends the rest of a command line after a literal.
async fn write_line<S: Transport>(
    session: &mut ImapSession<S>,
    line: &[u8],
) -> Result<(), MailServerError> {
    let stream = session.get_mut();
    stream.write_all(line).await?;
    stream.write_all(b"\r\n").await?;
    stream.flush().await?;
    Ok(())
}

/// Runs `command`: every answer up to its end goes to `each` (the final OK
/// too, for its response code). A NO or BAD comes back as a [`Refusal`].
pub async fn run_answered<S, F>(
    session: &mut ImapSession<S>,
    command: &Command,
    mut each: F,
) -> Result<Result<(), Refusal>, MailServerError>
where
    S: Transport,
    F: FnMut(&Response<'_>),
{
    let tag = match send(session, command, &mut each).await? {
        Ok(tag) => tag,
        Err(refused) => return Ok(Err(refused)),
    };
    loop {
        let response = next_answer!(session)?;
        let parsed = response.parsed();
        if let Response::Done {
            tag: done,
            status,
            outcome,
        } = parsed
            && *done == tag
        {
            return Ok(match status {
                Status::Ok => {
                    each(parsed);
                    Ok(())
                }
                _ => Err(refusal(outcome)),
            });
        }
        if let Response::Data {
            status: Status::Bye,
            outcome,
        } = parsed
        {
            return Err(MailServerError::unreachable(format!(
                "The server closed the connection: {}",
                outcome.information.as_deref().unwrap_or_default()
            )));
        }
        each(parsed);
    }
}

/// [`run_answered`], with a NO or BAD as the error.
pub async fn run<S, F>(
    session: &mut ImapSession<S>,
    command: &Command,
    each: F,
) -> Result<(), MailServerError>
where
    S: Transport,
    F: FnMut(&Response<'_>),
{
    run_answered(session, command, each)
        .await?
        .map_err(|refused| refused.error)
}

/// Runs several commands at once (sent together, answered in turn): each
/// one's result. The answers all go to `each`.
pub async fn run_all<S, F>(
    session: &mut ImapSession<S>,
    commands: &[String],
    mut each: F,
) -> Result<Vec<Result<(), MailServerError>>, MailServerError>
where
    S: Transport,
    F: FnMut(&Response<'_>),
{
    let mut tags = Vec::with_capacity(commands.len());
    for command in commands {
        tags.push(session.run_command(command).await?);
    }
    let mut results: Vec<Option<Result<(), MailServerError>>> = vec![None; commands.len()];
    while results.iter().any(Option::is_none) {
        let response = next_answer!(session)?;
        let parsed = response.parsed();
        if let Response::Done {
            tag,
            status,
            outcome,
        } = parsed
            && let Some(index) = tags.iter().position(|t| t == tag)
        {
            results[index] = Some(match status {
                Status::Ok => Ok(()),
                _ => Err(refusal(outcome).error),
            });
            continue;
        }
        each(parsed);
    }
    Ok(results.into_iter().map(Option::unwrap).collect())
}

/// The UIDs of a `UID SEARCH` or `UID SORT` answer, in the server's order.
pub async fn search<S: Transport>(
    session: &mut ImapSession<S>,
    command: &Command,
) -> Result<Result<Vec<u32>, Refusal>, MailServerError> {
    use async_imap::imap_proto::MailboxDatum;
    let mut uids = Vec::new();
    let answered = run_answered(session, command, |response| {
        if let Response::MailboxData(MailboxDatum::Search(found) | MailboxDatum::Sort(found)) =
            response
        {
            uids.extend_from_slice(found);
        }
    })
    .await?;
    Ok(answered.map(|()| uids))
}

/// UIDs as sets for commands (`1:3,7`), each short enough for one line.
pub fn uid_sets(uids: &[u32]) -> Vec<String> {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut sets = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    while index < sorted.len() {
        let start = sorted[index];
        let mut end = start;
        while index + 1 < sorted.len() && sorted[index + 1] == end + 1 {
            index += 1;
            end = sorted[index];
        }
        index += 1;
        let range = if start == end {
            start.to_string()
        } else {
            format!("{start}:{end}")
        };
        if !current.is_empty() && current.len() + range.len() + 1 > MAX_SET_LENGTH {
            sets.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(',');
        }
        current.push_str(&range);
    }
    if !current.is_empty() {
        sets.push(current);
    }
    sets
}

/// The UIDs of a set in a response code (APPENDUID, COPYUID), in order.
pub fn expand(set: &[UidSetMember]) -> Vec<u32> {
    let mut uids = Vec::new();
    for member in set {
        match member {
            UidSetMember::Uid(uid) => uids.push(*uid),
            UidSetMember::UidRange(range) => uids.extend(range.clone()),
        }
    }
    uids
}

/// `COPYUID` in an answer: the target's UIDVALIDITY and old UID → new UID.
pub fn copy_uid(response: &Response<'_>) -> Option<(u32, Vec<(u32, u32)>)> {
    let code = match response {
        Response::Data { outcome, .. } | Response::Done { outcome, .. } => outcome.code.as_ref(),
        _ => None,
    };
    match code {
        Some(ResponseCode::CopyUid(validity, from, to)) => Some((
            *validity,
            expand(from).into_iter().zip(expand(to)).collect(),
        )),
        _ => None,
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Days since 1970 of a date (Howard Hinnant's days-from-civil).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day since 1970: year, month (1–12), day.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// An INTERNALDATE (`17-Jul-1996 02:44:25 -0700`) as milliseconds since 1970.
pub fn parse_internal_date(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(' ')?;
    let (time, zone) = rest.trim().split_once(' ')?;
    let mut date = date.split('-');
    let day: i64 = date.next()?.trim().parse().ok()?;
    let month = date.next()?;
    let month = MONTHS.iter().position(|m| m.eq_ignore_ascii_case(month))? as i64 + 1;
    let year: i64 = date.next()?.parse().ok()?;
    let mut time = time.split(':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: i64 = time.next()?.parse().ok()?;
    let zone = zone.trim();
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let offset: i64 = zone.get(1..5)?.parse().ok()?;
    let offset = sign * (offset / 100 * 3600 + offset % 100 * 60);
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    Some(seconds * 1000)
}

/// Milliseconds since 1970 as an IMAP date-time (UTC), for APPEND.
pub fn date_time(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let rest = seconds.rem_euclid(86_400);
    format!(
        "{day:02}-{}-{year:04} {:02}:{:02}:{:02} +0000",
        MONTHS[(month - 1) as usize],
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Milliseconds since 1970 as ISO 8601 (UTC), for the UI.
pub fn iso(ms: i64) -> String {
    super::tls::iso8601(ms.div_euclid(1000))
}

/// Milliseconds since 1970, now.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A FETCH answer's `PREVIEW` (RFC 8970), read from its raw bytes (imap-proto
/// skips it): the UID and the preview, if the answer has both.
pub fn raw_preview(raw: &[u8]) -> Option<(u32, String)> {
    let start = find(raw, b" FETCH (")? + 8;
    let mut reader = Reader {
        bytes: raw,
        at: start,
    };
    let mut uid = None;
    let mut preview = None;
    loop {
        reader.spaces();
        match reader.peek()? {
            b')' => break,
            _ => {
                let name = reader.atom()?.to_ascii_uppercase();
                reader.spaces();
                let value = reader.value()?;
                match name.as_str() {
                    "UID" => uid = value.and_then(|v| String::from_utf8(v).ok()?.parse().ok()),
                    "PREVIEW" => preview = value.map(|v| String::from_utf8_lossy(&v).into_owned()),
                    _ => {}
                }
            }
        }
    }
    Some((uid?, preview?))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

/// Reads the items of a FETCH answer: atoms, numbers, quoted strings,
/// literals, NIL and parenthesized lists.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn spaces(&mut self) {
        while self.peek() == Some(b' ') {
            self.at += 1;
        }
    }

    fn atom(&mut self) -> Option<String> {
        let start = self.at;
        while let Some(b) = self.peek() {
            if b == b' ' || b == b'(' || b == b')' || b == b'\r' {
                break;
            }
            // `BODY[...]` names keep their brackets' contents.
            if b == b'[' {
                while self.peek()? != b']' {
                    self.at += 1;
                }
            }
            self.at += 1;
        }
        (self.at > start).then(|| String::from_utf8_lossy(&self.bytes[start..self.at]).into_owned())
    }

    /// A value: `None` for NIL and lists (whose contents don't matter here).
    fn value(&mut self) -> Option<Option<Vec<u8>>> {
        match self.peek()? {
            b'"' => {
                self.at += 1;
                let mut out = Vec::new();
                loop {
                    match self.peek()? {
                        b'"' => {
                            self.at += 1;
                            return Some(Some(out));
                        }
                        b'\\' => {
                            out.push(*self.bytes.get(self.at + 1)?);
                            self.at += 2;
                        }
                        b => {
                            out.push(b);
                            self.at += 1;
                        }
                    }
                }
            }
            b'{' => {
                let close = self.at + self.bytes[self.at..].iter().position(|&b| b == b'}')?;
                let length: usize = std::str::from_utf8(&self.bytes[self.at + 1..close])
                    .ok()?
                    .trim_end_matches('+')
                    .parse()
                    .ok()?;
                let start = close + 3; // "}\r\n"
                let end = start.checked_add(length)?;
                let value = self.bytes.get(start..end)?.to_vec();
                self.at = end;
                Some(Some(value))
            }
            b'(' => {
                let mut depth = 0usize;
                loop {
                    match self.peek()? {
                        b'(' => depth += 1,
                        b')' => {
                            depth -= 1;
                            if depth == 0 {
                                self.at += 1;
                                return Some(None);
                            }
                        }
                        b'"' => {
                            self.value()?;
                            continue;
                        }
                        b'{' => {
                            self.value()?;
                            continue;
                        }
                        _ => {}
                    }
                    self.at += 1;
                }
            }
            _ => {
                let atom = self.atom()?;
                Some((!atom.eq_ignore_ascii_case("NIL")).then(|| atom.into_bytes()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_or_sends_literals() {
        let command = Command::new("UID SEARCH CHARSET UTF-8 TEXT ")
            .string("Grüße")
            .text(" FROM ")
            .string("a\"b");
        assert_eq!(
            command.render(false),
            "UID SEARCH CHARSET UTF-8 TEXT {7} FROM \"a\\\"b\""
        );
        assert_eq!(
            command.render(true),
            "UID SEARCH CHARSET UTF-8 TEXT \"Grüße\" FROM \"a\\\"b\""
        );
        assert!(!quotable("a\r\nb", true));
    }

    #[test]
    fn writes_uid_sets() {
        assert_eq!(uid_sets(&[5, 1, 2, 3, 9, 7, 8, 3]), vec!["1:3,5,7:9"]);
        assert!(uid_sets(&[]).is_empty());
        let many: Vec<u32> = (0..3000).map(|n| n * 2).collect();
        let sets = uid_sets(&many);
        assert!(sets.len() > 1);
        assert!(sets.iter().all(|set| set.len() <= MAX_SET_LENGTH));
        let back: Vec<u32> = sets
            .iter()
            .flat_map(|set| set.split(','))
            .map(|n| n.parse::<u32>().unwrap())
            .collect();
        assert_eq!(back, many);
    }

    #[test]
    fn reads_and_writes_dates() {
        let ms = parse_internal_date("17-Jul-1996 02:44:25 -0700").unwrap();
        assert_eq!(iso(ms), "1996-07-17T09:44:25Z");
        assert_eq!(
            parse_internal_date(" 1-Jan-2026 00:00:00 +0100")
                .map(iso)
                .as_deref(),
            Some("2025-12-31T23:00:00Z")
        );
        assert_eq!(date_time(ms), "17-Jul-1996 09:44:25 +0000");
        assert_eq!(parse_internal_date("soon"), None);
    }

    #[test]
    fn reads_previews_from_raw_answers() {
        assert_eq!(
            raw_preview(b"* 3 FETCH (UID 17 PREVIEW \"Hello \\\"you\\\"\")\r\n"),
            Some((17, "Hello \"you\"".into()))
        );
        assert_eq!(
            raw_preview(b"* 3 FETCH (FLAGS (\\Seen) PREVIEW {5}\r\nHi :) UID 9)\r\n"),
            Some((9, "Hi :)".into()))
        );
        assert_eq!(raw_preview(b"* 3 FETCH (UID 9 PREVIEW NIL)\r\n"), None);
    }
}
