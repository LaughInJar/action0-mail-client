//! An account's connections: up to two worker sessions, each handed to one
//! caller at a time and kept for the next one afterwards. A session that sat
//! unused for more than four minutes gets a `NOOP` before it's handed out;
//! one that turns out broken is replaced by a new connection (and the other
//! kept ones are dropped with it: they most likely broke the same way).
//!
//! A refused login is remembered and answered at once from then on, so a
//! wrong password isn't tried again and again (servers lock accounts for
//! that); reconnecting the account makes a new pool.

use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::error::{ErrorKind, MailServerError};
use super::session::ImapSession;

/// How many sessions an account has at most (IDLE's comes on top).
pub const WORKERS: usize = 2;
/// How long a session may sit unused before it's checked.
pub const IDLE_CHECK: Duration = Duration::from_secs(4 * 60);

/// A session waiting for its next use, and since when.
struct Kept {
    session: ImapSession,
    /// Wall-clock time: it also counts while the computer sleeps.
    since: SystemTime,
}

/// One account's sessions.
pub struct Pool {
    permits: Arc<Semaphore>,
    kept: Mutex<Vec<Kept>>,
    /// Closed: sessions coming back are dropped.
    closed: AtomicBool,
    /// The login was refused (`auth`): refused again without trying.
    refused: Mutex<Option<MailServerError>>,
    idle_check: Duration,
}

impl Pool {
    pub fn new() -> Arc<Self> {
        Self::with_idle_check(IDLE_CHECK)
    }

    /// A pool that checks sessions unused for longer than `idle_check`.
    pub fn with_idle_check(idle_check: Duration) -> Arc<Self> {
        Arc::new(Self {
            permits: Arc::new(Semaphore::new(WORKERS)),
            kept: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            refused: Mutex::new(None),
            idle_check,
        })
    }

    /// A session for one caller: a kept one, else a new one from `open`.
    /// Waits while all are in use. `fresh` drops the kept ones first (the
    /// last one handed out turned out broken).
    pub async fn get<F, Fut>(
        self: &Arc<Self>,
        open: F,
        fresh: bool,
    ) -> Result<PooledSession, MailServerError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<ImapSession, MailServerError>>,
    {
        if let Some(error) = self.refused() {
            return Err(error);
        }
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .expect("the semaphore is never closed");
        if fresh {
            self.kept.lock().expect("pool lock").clear();
        }
        let kept = self.kept.lock().expect("pool lock").pop();
        if let Some(Kept { mut session, since }) = kept {
            let rested = SystemTime::now()
                .duration_since(since)
                .map_or(true, |rest| rest > self.idle_check);
            if !rested || session.ping().await.is_ok() {
                // Leftovers of earlier work aren't news for this caller.
                while session.unsolicited_responses.try_recv().is_ok() {}
                return Ok(PooledSession::new(session, self.clone(), permit, true));
            }
            self.kept.lock().expect("pool lock").clear();
        }
        match open().await {
            Ok(session) => Ok(PooledSession::new(session, self.clone(), permit, false)),
            Err(error) => {
                if error.kind == ErrorKind::Auth {
                    self.refuse(error.clone());
                }
                Err(error)
            }
        }
    }

    /// Keeps a session made elsewhere (adding the account logged in already).
    pub fn keep(&self, session: ImapSession) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let mut kept = self.kept.lock().expect("pool lock");
        kept.push(Kept {
            session,
            since: SystemTime::now(),
        });
        // The oldest go first.
        while kept.len() > WORKERS {
            kept.remove(0);
        }
    }

    /// Drops the kept sessions; those in use are dropped when they come back.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.kept.lock().expect("pool lock").clear();
    }

    /// The refused login, if the pool remembers one.
    pub fn refused(&self) -> Option<MailServerError> {
        self.refused.lock().expect("pool lock").clone()
    }

    /// Remembers a refused login (made outside the pool: IDLE's).
    pub fn refuse(&self, error: MailServerError) {
        *self.refused.lock().expect("pool lock") = Some(error);
    }
}

/// A session from the pool, for one caller. Derefs to [`ImapSession`] (and
/// on to async-imap's `Session`). Dropping it puts the session back;
/// [`PooledSession::discard`] closes it instead, after a connection error.
pub struct PooledSession {
    session: Option<ImapSession>,
    pool: Arc<Pool>,
    reused: bool,
    // Released after `drop` has put the session back.
    _permit: OwnedSemaphorePermit,
}

impl PooledSession {
    fn new(
        session: ImapSession,
        pool: Arc<Pool>,
        permit: OwnedSemaphorePermit,
        reused: bool,
    ) -> Self {
        Self {
            session: Some(session),
            pool,
            reused,
            _permit: permit,
        }
    }

    /// True if the session was used before (it may have broken meanwhile).
    pub fn reused(&self) -> bool {
        self.reused
    }

    /// Closes the session instead of keeping it (it's broken, or in a state
    /// the next caller shouldn't get).
    pub fn discard(mut self) {
        self.session = None;
    }
}

impl Deref for PooledSession {
    type Target = ImapSession;

    fn deref(&self) -> &ImapSession {
        self.session.as_ref().expect("a pooled session")
    }
}

impl DerefMut for PooledSession {
    fn deref_mut(&mut self) -> &mut ImapSession {
        self.session.as_mut().expect("a pooled session")
    }
}

impl Drop for PooledSession {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            self.pool.keep(session);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use tokio::task::JoinHandle;

    use super::*;
    use crate::imap::account::{MailServer, Security};
    use crate::imap::session::{Login, Secret, Stream, login_on};
    use crate::imap::testing::scripted;

    const LOGIN: &str = "
        S: * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] hi
        C: A0001 AUTHENTICATE PLAIN AHVzZXIAcGFzcw==
        S: A0001 OK in
        C: A0002 CAPABILITY
        S: * CAPABILITY IMAP4rev1
        S: A0002 OK done
    ";

    /// A session over a scripted server: the login, then `rest`.
    async fn session(rest: &str) -> (ImapSession, JoinHandle<Result<(), String>>) {
        let (stream, script) = scripted(&format!("{LOGIN}{rest}"));
        let server = MailServer {
            host: "imap.example.org".into(),
            port: 993,
            security: Security::Tls,
        };
        let login = Login {
            server: &server,
            username: "user",
            secret: Secret::Password("pass"),
        };
        let session = login_on(Box::new(stream) as Stream, true, &login)
            .await
            .unwrap();
        (session, script)
    }

    #[tokio::test]
    async fn hands_out_kept_sessions_and_opens_new_ones() {
        let pool = Pool::new();
        let opened = AtomicUsize::new(0);
        let open = || async {
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(session("").await.0)
        };
        let first = pool.get(open, false).await.unwrap();
        assert!(!first.reused());
        let second = pool.get(open, false).await.unwrap();
        assert_eq!(opened.load(Ordering::SeqCst), 2);
        drop(first);
        let again = pool.get(open, false).await.unwrap();
        assert!(again.reused());
        assert_eq!(opened.load(Ordering::SeqCst), 2);

        // Both in use: a third caller waits.
        let waiting = tokio::time::timeout(Duration::from_millis(50), pool.get(open, false)).await;
        assert!(waiting.is_err());
        drop(second);
        let third = pool.get(open, false).await.unwrap();
        assert!(third.reused());

        // Discarded sessions aren't kept; closing drops the rest.
        third.discard();
        drop(again);
        pool.close();
        let after = pool.get(open, false).await.unwrap();
        assert!(!after.reused());
        drop(after);
        assert!(pool.kept.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn checks_rested_sessions_and_replaces_broken_ones() {
        let pool = Pool::with_idle_check(Duration::ZERO);
        let (alive, alive_script) = session(
            "
            C: A0003 NOOP
            S: * 4 EXISTS
            S: A0003 OK NOOP completed
            ",
        )
        .await;
        pool.keep(alive);
        tokio::time::sleep(Duration::from_millis(5)).await;
        let opened = AtomicUsize::new(0);
        let open = || async {
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(session("").await.0)
        };
        let checked = pool.get(open, false).await.unwrap();
        assert!(checked.reused());
        // The EXISTS from the NOOP isn't handed on.
        assert!(checked.unsolicited_responses.is_empty());
        alive_script.await.unwrap().unwrap();
        // That script has ended: the server's gone, the NOOP fails.
        drop(checked);
        tokio::time::sleep(Duration::from_millis(5)).await;
        let replaced = pool.get(open, false).await.unwrap();
        assert!(!replaced.reused());
        assert_eq!(opened.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remembers_a_refused_login() {
        let pool = Pool::new();
        let opened = AtomicUsize::new(0);
        let open = || async {
            opened.fetch_add(1, Ordering::SeqCst);
            Err(MailServerError::auth("Authentication failed."))
        };
        assert_eq!(
            pool.get(open, false).await.err().unwrap().kind,
            ErrorKind::Auth
        );
        assert_eq!(
            pool.get(open, false).await.err().unwrap().kind,
            ErrorKind::Auth
        );
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        assert!(pool.refused().is_some());

        // Other failures are tried again.
        let pool = Pool::new();
        let open = || async {
            opened.fetch_add(1, Ordering::SeqCst);
            Err(MailServerError::unreachable("offline"))
        };
        let _ = pool.get(open, false).await;
        let _ = pool.get(open, false).await;
        assert_eq!(opened.load(Ordering::SeqCst), 3);
    }
}
