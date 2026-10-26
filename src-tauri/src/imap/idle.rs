//! IDLE on the Inbox (desktop): one more session per account that waits for
//! the server to say the Inbox changed (EXISTS, EXPUNGE, FETCH), and then
//! tells the UI with the `imap-changed` event (`{key}`, a second after the
//! last change), which checks for mail as it does every minute. IDLE is
//! renewed every 25 minutes (servers end it after 30); after an error the
//! session is opened again after 30 s, 1 minute, then every 5 minutes. A
//! server without IDLE gets none (the UI's checks still run); a refused
//! login stops it until the account reconnects.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::Duration;

use async_imap::imap_proto::{MailboxDatum, Response, Status};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::Instant;

use super::Imap;
use super::error::{ErrorKind, MailServerError};
use super::proto::{next_answer, read_error};
use super::session::{Access, ImapSession, Transport};

/// The event the UI listens to.
pub const EVENT: &str = "imap-changed";
/// How long one IDLE lasts before it's renewed.
const RENEW: Duration = Duration::from_secs(25 * 60);
/// Changes within this time make one event.
const SETTLE: Duration = Duration::from_secs(1);
/// The waits before opening the session again after errors in a row.
const BACKOFF: [Duration; 3] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(5 * 60),
];
/// A session that lasted this long resets the backoff.
const STABLE: Duration = Duration::from_secs(2 * 60);

#[derive(Clone, Serialize)]
struct Changed {
    key: String,
}

/// The accounts' IDLE tasks.
#[derive(Default)]
pub struct Idlers {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl Idlers {
    /// Starts watching an account's Inbox (again, if it was).
    pub fn start(&self, app: &AppHandle, key: &str) {
        let task = tauri::async_runtime::spawn(watch(app.clone(), key.to_string()));
        if let Some(old) = self
            .tasks
            .lock()
            .expect("idle lock")
            .insert(key.to_string(), task)
        {
            old.abort();
        }
    }

    /// Stops watching an account's Inbox.
    pub fn stop(&self, key: &str) {
        if let Some(task) = self.tasks.lock().expect("idle lock").remove(key) {
            task.abort();
        }
    }
}

/// Watches every kept account (at start).
pub fn start_all(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let imap = app.state::<Imap>();
        let keys: Vec<String> = imap.vault().all().into_keys().collect();
        for key in keys {
            imap.idlers.start(&app, &key);
        }
    });
}

async fn watch(app: AppHandle, key: String) {
    let mut failures = 0;
    loop {
        let imap = app.state::<Imap>();
        let started = Instant::now();
        let error = match imap.dedicated_session(&key).await {
            Ok(session) if !session.capabilities.has("IDLE") => return,
            Ok(mut session) => {
                let notify = || {
                    let _ = app.emit(EVENT, Changed { key: key.clone() });
                };
                idle(&mut session, RENEW, SETTLE, notify).await
            }
            Err(error) => error,
        };
        // A refused login waits for Reconnect; a removed account is gone.
        if matches!(error.kind, ErrorKind::Auth | ErrorKind::NotFound) {
            return;
        }
        if started.elapsed() > STABLE {
            failures = 0;
        }
        tokio::time::sleep(BACKOFF[failures.min(BACKOFF.len() - 1)]).await;
        failures += 1;
    }
}

/// An answer that means the Inbox changed.
fn is_change(response: &Response<'_>) -> bool {
    matches!(
        response,
        Response::MailboxData(MailboxDatum::Exists(_))
            | Response::Expunge(_)
            | Response::Vanished { .. }
            | Response::Fetch(..)
    )
}

/// IDLEs on the Inbox until something fails (the error), calling `changed`
/// `settle` after the last of a burst of changes; renewed every `renew`.
pub async fn idle<S: Transport, F: FnMut()>(
    session: &mut ImapSession<S>,
    renew: Duration,
    settle: Duration,
    mut changed: F,
) -> MailServerError {
    match idle_loop(session, renew, settle, &mut changed).await {
        Ok(never) => match never {},
        Err(error) => error,
    }
}

async fn idle_loop<S: Transport, F: FnMut()>(
    session: &mut ImapSession<S>,
    renew: Duration,
    settle: Duration,
    changed: &mut F,
) -> Result<Infallible, MailServerError> {
    session.open_folder("INBOX", Access::ReadOnly).await?;
    loop {
        let tag = session.run_command("IDLE").await?;
        let mut pending: Option<Instant> = None;
        loop {
            let response = next_answer!(session)?;
            match response.parsed() {
                Response::Continue { .. } => break,
                Response::Done {
                    tag: done, outcome, ..
                } if *done == tag => {
                    return Err(MailServerError::answered(&format!("{outcome:?}")));
                }
                other if is_change(other) => pending = Some(Instant::now() + settle),
                _ => {}
            }
        }
        let renew_at = Instant::now() + renew;
        loop {
            let until = pending.map_or(renew_at, |at| at.min(renew_at));
            match tokio::time::timeout_at(until, session.read_response()).await {
                Err(_) => {
                    if pending.is_some_and(|at| at <= Instant::now()) {
                        pending = None;
                        changed();
                        continue;
                    }
                    break;
                }
                Ok(Ok(Some(response))) => {
                    if let Response::Data {
                        status: Status::Bye,
                        ..
                    } = response.parsed()
                    {
                        return Err(MailServerError::unreachable("The server ended IDLE."));
                    }
                    if is_change(response.parsed()) {
                        pending = Some(Instant::now() + settle);
                    }
                }
                Ok(Ok(None)) => {
                    return Err(MailServerError::unreachable(
                        "The server closed the connection.",
                    ));
                }
                Ok(Err(error)) => return Err(read_error(error)),
            }
        }
        session.run_command_untagged("DONE").await?;
        loop {
            let response = next_answer!(session)?;
            match response.parsed() {
                Response::Done {
                    tag: done,
                    status,
                    outcome,
                } if *done == tag => {
                    if *status != Status::Ok {
                        return Err(MailServerError::answered(&format!("{outcome:?}")));
                    }
                    break;
                }
                other if is_change(other) => pending = Some(Instant::now()),
                _ => {}
            }
        }
        if pending.is_some() {
            changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::testing::logged_in;

    #[tokio::test]
    async fn tells_of_changes_once_per_burst_and_renews() {
        let (mut session, server) = logged_in(
            "IMAP4rev1 IDLE",
            "
            C: A0003 EXAMINE \"INBOX\"
            S: * 1 EXISTS
            S: * OK [UIDVALIDITY 1] ok
            S: A0003 OK done
            C: A0004 IDLE
            S: + idling
            S: * 2 EXISTS
            S: * 1 RECENT
            S: * 1 FETCH (FLAGS (\\Seen))
            C: DONE
            S: A0004 OK IDLE terminated
            C: A0005 IDLE
            S: + idling
            ",
        )
        .await;
        let mut changes = 0;
        let error = idle(
            &mut session,
            Duration::from_millis(400),
            Duration::from_millis(50),
            || changes += 1,
        )
        .await;
        server.await.unwrap().unwrap();
        assert_eq!(changes, 1);
        assert_eq!(error.kind, ErrorKind::Unreachable);
    }
}
