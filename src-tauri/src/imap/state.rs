//! What's kept in memory per IMAP account while the app runs: where each
//! message is (ids), the folders as last listed, the lists being paged
//! through, the last messages opened, what the last change check saw, and
//! where conversations were listed. Nothing of it is written to disk.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use super::folders::FolderTree;
use super::ids::IdMap;
use super::list::Snapshots;
use super::parse::RawCache;
use super::sync::SyncMemory;

/// How many conversations' folders are remembered (all are forgotten beyond).
const LISTED_THREADS: usize = 5000;

/// Every account's memory, by account key.
#[derive(Default)]
pub struct Mail {
    accounts: Mutex<HashMap<String, Arc<Account>>>,
}

impl Mail {
    pub fn account(&self, key: &str) -> Arc<Account> {
        self.accounts
            .lock()
            .expect("imap lock")
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// Forgets an account's memory (it was removed or replaced).
    pub fn forget(&self, key: &str) {
        self.accounts.lock().expect("imap lock").remove(key);
    }
}

/// One account's memory.
#[derive(Default)]
pub struct Account {
    pub ids: Mutex<IdMap>,
    folders: Mutex<Option<Arc<FolderTree>>>,
    pub snapshots: Mutex<Snapshots>,
    /// Whole messages, behind `cached`/`cache`/`uncache`, which never hand
    /// out the lock (a guard kept in a `match` once deadlocked).
    raw: Mutex<RawCache>,
    pub sync: Mutex<SyncMemory>,
    /// The folder each conversation was last listed in.
    listed_in: Mutex<HashMap<String, String>>,
}

impl Account {
    pub fn ids(&self) -> MutexGuard<'_, IdMap> {
        self.ids.lock().expect("imap lock")
    }

    /// A whole message kept in memory (now the most recently used).
    pub fn cached(&self, id: &str) -> Option<Arc<Vec<u8>>> {
        self.raw.lock().expect("imap lock").get(id)
    }

    /// Keeps a whole message in memory.
    pub fn cache(&self, id: &str, raw: Arc<Vec<u8>>) {
        self.raw.lock().expect("imap lock").put(id, raw);
    }

    /// Forgets whole messages (deleted for good).
    pub fn uncache<'a>(&self, ids: impl IntoIterator<Item = &'a str>) {
        let mut raw = self.raw.lock().expect("imap lock");
        for id in ids {
            raw.remove(id);
        }
    }

    /// The folders as last listed, if they were.
    pub fn tree(&self) -> Option<Arc<FolderTree>> {
        self.folders.lock().expect("imap lock").clone()
    }

    pub fn set_tree(&self, tree: Arc<FolderTree>) {
        *self.folders.lock().expect("imap lock") = Some(tree);
    }

    /// The folders changed: list them again when next needed.
    pub fn forget_tree(&self) {
        *self.folders.lock().expect("imap lock") = None;
    }

    pub fn note_listed(&self, thread: &str, folder: &str) {
        let mut listed = self.listed_in.lock().expect("imap lock");
        if listed.len() >= LISTED_THREADS {
            listed.clear();
        }
        listed.insert(thread.to_string(), folder.to_string());
    }

    pub fn listed_in(&self, thread: &str) -> Option<String> {
        self.listed_in
            .lock()
            .expect("imap lock")
            .get(thread)
            .cloned()
    }
}
