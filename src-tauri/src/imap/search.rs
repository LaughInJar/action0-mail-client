//! Searching on the server: the search field's text (`from:anna`, `to:x`,
//! `subject:x`, `is:unread`, `is:starred`, quoted phrases and words) as IMAP
//! search keys, all of which must match. Gmail gets the whole text as
//! `X-GM-RAW`, which knows its own operators.
//!
//! Non-ASCII words go as UTF-8: quoted after `ENABLE UTF8=ACCEPT` (then
//! without a CHARSET, as RFC 6855 wants), else as literals with `CHARSET
//! UTF-8`; ASCII-only searches name no charset, so servers that know only
//! US-ASCII can still search them.

use super::proto::Command;

/// One thing a message must match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Term {
    From(String),
    To(String),
    Subject(String),
    /// Anywhere in the header or body.
    Text(String),
    Unseen,
    Seen,
    Flagged,
}

/// What a list searches for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub terms: Vec<Term>,
    /// Gmail: the text as it was typed.
    pub gmail: Option<String>,
}

impl Query {
    /// The query for the search field's `text` (none: everything).
    pub fn new(text: Option<&str>, gmail: bool) -> Self {
        let text = text.map(str::trim).filter(|text| !text.is_empty());
        match text {
            Some(text) if gmail => Self {
                terms: Vec::new(),
                gmail: Some(text.to_string()),
            },
            Some(text) => Self {
                terms: parse(text),
                gmail: None,
            },
            None => Self::default(),
        }
    }

    fn is_ascii(&self) -> bool {
        self.gmail.as_deref().is_none_or(str::is_ascii)
            && self.terms.iter().all(|term| match term {
                Term::From(s) | Term::To(s) | Term::Subject(s) | Term::Text(s) => s.is_ascii(),
                Term::Unseen | Term::Seen | Term::Flagged => true,
            })
    }

    /// The search keys after `keys` (atoms such as `UNDELETED FLAGGED`).
    fn keys(&self, command: Command, keys: &str) -> Command {
        let mut command = command.text(keys);
        if let Some(raw) = &self.gmail {
            return command.text(" X-GM-RAW ").string(raw.clone());
        }
        for term in &self.terms {
            command = match term {
                Term::From(s) => command.text(" FROM ").string(s.clone()),
                Term::To(s) => command.text(" TO ").string(s.clone()),
                Term::Subject(s) => command.text(" SUBJECT ").string(s.clone()),
                Term::Text(s) => command.text(" TEXT ").string(s.clone()),
                Term::Unseen => command.text(" UNSEEN"),
                Term::Seen => command.text(" SEEN"),
                Term::Flagged => command.text(" FLAGGED"),
            };
        }
        command
    }

    /// `UID SEARCH` for this query and `keys` (never empty: e.g. `UNDELETED`).
    /// `utf8`: UTF8=ACCEPT is on.
    pub fn search(&self, keys: &str, utf8: bool) -> Command {
        let start = if self.is_ascii() || utf8 {
            "UID SEARCH "
        } else {
            "UID SEARCH CHARSET UTF-8 "
        };
        self.keys(Command::new(start), keys)
    }

    /// `UID SORT` by arrival (INTERNALDATE), newest first if `reverse`.
    pub fn sort(&self, keys: &str, reverse: bool) -> Command {
        let order = if reverse {
            "(REVERSE ARRIVAL)"
        } else {
            "(ARRIVAL)"
        };
        let charset = if self.is_ascii() { "US-ASCII" } else { "UTF-8" };
        self.keys(Command::new(format!("UID SORT {order} {charset} ")), keys)
    }
}

/// The search field's text as terms.
pub fn parse(text: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let mut chars = text.chars().peekable();
    let quoted = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
        let mut out = String::new();
        for c in chars.by_ref() {
            if c == '"' {
                break;
            }
            out.push(c);
        }
        out
    };
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '"' {
            chars.next();
            let phrase = quoted(&mut chars);
            if !phrase.trim().is_empty() {
                terms.push(Term::Text(phrase));
            }
            continue;
        }
        let mut word = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            chars.next();
            if c == '"' && word.ends_with(':') {
                word.push_str(&quoted(&mut chars));
                break;
            }
            word.push(c);
        }
        if let Some(term) = term(&word) {
            terms.push(term);
        }
    }
    terms
}

fn term(word: &str) -> Option<Term> {
    let Some((key, value)) = word.split_once(':') else {
        return Some(Term::Text(word.to_string()));
    };
    let value = value.to_string();
    let known = match key.to_ascii_lowercase().as_str() {
        "from" => Term::From(value),
        "to" => Term::To(value),
        "subject" => Term::Subject(value),
        "is" => match value.to_ascii_lowercase().as_str() {
            "unread" => Term::Unseen,
            "read" => Term::Seen,
            "starred" | "flagged" => Term::Flagged,
            _ => return Some(Term::Text(word.to_string())),
        },
        _ => return Some(Term::Text(word.to_string())),
    };
    match &known {
        Term::From(v) | Term::To(v) | Term::Subject(v) if v.trim().is_empty() => None,
        _ => Some(known),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_search_field() {
        assert_eq!(
            parse(
                "from:anna \"lunch plans\" is:unread Subject:\"Q3 report\" to: rest is:STARRED x:y"
            ),
            vec![
                Term::From("anna".into()),
                Term::Text("lunch plans".into()),
                Term::Unseen,
                Term::Subject("Q3 report".into()),
                Term::Text("rest".into()),
                Term::Flagged,
                Term::Text("x:y".into()),
            ]
        );
        assert!(parse("   ").is_empty());
        assert_eq!(
            parse("\"unclosed phrase"),
            vec![Term::Text("unclosed phrase".into())]
        );
    }

    #[test]
    fn writes_search_keys() {
        let query = Query::new(Some("from:anna is:starred invoice"), false);
        assert_eq!(
            query.search("UNDELETED", false).render(false),
            "UID SEARCH UNDELETED FROM \"anna\" FLAGGED TEXT \"invoice\""
        );
        let query = Query::new(Some("Grüße from:\"Anna Berger\""), false);
        assert_eq!(
            query.search("UNDELETED", false).render(false),
            "UID SEARCH CHARSET UTF-8 UNDELETED TEXT {7} FROM \"Anna Berger\""
        );
        // After ENABLE UTF8=ACCEPT: quoted, and no CHARSET.
        assert_eq!(
            query.search("UNDELETED", true).render(true),
            "UID SEARCH UNDELETED TEXT \"Grüße\" FROM \"Anna Berger\""
        );
        assert_eq!(
            query.sort("UNDELETED FLAGGED", true).render(false),
            "UID SORT (REVERSE ARRIVAL) UTF-8 UNDELETED FLAGGED TEXT {7} FROM \"Anna Berger\""
        );
        assert_eq!(
            Query::new(None, false)
                .sort("UNDELETED", false)
                .render(false),
            "UID SORT (ARRIVAL) US-ASCII UNDELETED"
        );
    }

    #[test]
    fn gives_gmail_the_whole_text() {
        let query = Query::new(Some(" from:anna has:attachment "), true);
        assert_eq!(
            query.search("UNDELETED", true).render(true),
            "UID SEARCH UNDELETED X-GM-RAW \"from:anna has:attachment\""
        );
        assert_eq!(Query::new(Some(""), true), Query::default());
    }
}
