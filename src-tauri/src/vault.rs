//! Where refresh tokens (and the AI assistant's keys) are kept: encrypted
//! (XChaCha20-Poly1305) in files of the app's data folder, with the key in
//! the OS keychain (on Android: wrapped by the Android Keystore). Keychains
//! limit an entry's size (Windows: 2560 bytes), so only the key goes there,
//! and all vault files share it. Without a keychain, nothing is written:
//! accounts stay signed in until the app quits.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::oauth::providers::{Client, Provider};

/// An account as kept between starts.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub provider: Provider,
    pub client: Client,
    pub refresh_token: String,
    /// The scopes granted.
    pub scopes: Vec<String>,
    pub email: String,
    #[serde(default)]
    pub tenant: Option<String>,
}

/// Where the key is kept.
pub trait KeyStore: Send + Sync {
    /// The key, if there is one yet.
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn save(&self, key: &[u8]) -> Result<(), String>;
}

/// A key that's already known (the background check gets it from Kotlin).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct FixedKey(pub Vec<u8>);

impl KeyStore for FixedKey {
    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(Some(self.0.clone()))
    }

    fn save(&self, _key: &[u8]) -> Result<(), String> {
        Err("The key is fixed.".into())
    }
}

/// The OS keychain (Secret Service, Keychain, Credential Manager).
#[cfg(desktop)]
pub struct OsKeyStore {
    pub service: String,
}

#[cfg(desktop)]
impl KeyStore for OsKeyStore {
    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(&self.service, "vault-key").map_err(|e| e.to_string())?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, key: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, "vault-key").map_err(|e| e.to_string())?;
        entry.set_secret(key).map_err(|e| e.to_string())
    }
}

/// One key for several vault files: loaded, or made and saved, once on
/// first use, so two files never end up with different keys.
pub struct SharedKey {
    keys: Box<dyn KeyStore>,
    key: OnceLock<Option<Vec<u8>>>,
}

impl SharedKey {
    pub fn new(keys: Box<dyn KeyStore>) -> Self {
        Self {
            keys,
            key: OnceLock::new(),
        }
    }
}

impl KeyStore for SharedKey {
    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        self.key
            .get_or_init(|| vault_key(self.keys.as_ref()))
            .clone()
            .map(Some)
            .ok_or_else(|| "There's no keychain.".to_string())
    }

    fn save(&self, _key: &[u8]) -> Result<(), String> {
        // Never asked: `load` always has a key, or fails.
        Err("The key is shared.".into())
    }
}

/// The key in `keys`, or a new one saved there; `None` without a keychain.
fn vault_key(keys: &dyn KeyStore) -> Option<Vec<u8>> {
    match keys.load() {
        Ok(Some(key)) if key.len() == 32 => Some(key),
        Ok(_) => {
            let mut key = vec![0u8; 32];
            rand::rng().fill_bytes(&mut key);
            keys.save(&key).ok().map(|()| key)
        }
        Err(_) => None,
    }
}

const MAGIC: &[u8; 4] = b"A0V1";
const NONCE: usize = 24;

/// The accounts, by key (`gmail:<email>`, `microsoft:<email>`).
pub type Accounts = BTreeMap<String, StoredAccount>;

/// What a vault file can hold: its entries, by key.
pub trait Entry: Clone + Serialize + DeserializeOwned + Send {}

impl<T: Clone + Serialize + DeserializeOwned + Send> Entry for T {}

/// A vault file's entries, by key (accounts: `StoredAccount`s).
pub struct Vault<T = StoredAccount> {
    path: PathBuf,
    /// `None` without a keychain: nothing is written.
    key: Option<Vec<u8>>,
    entries: Mutex<BTreeMap<String, T>>,
}

/// A vault opened on first use: on Android its key comes from the Kotlin
/// side, which can only be asked once the app runs.
pub struct LazyVault<T = StoredAccount> {
    path: PathBuf,
    keys: Arc<dyn KeyStore>,
    vault: OnceLock<Vault<T>>,
}

impl<T: Entry> LazyVault<T> {
    pub fn new(path: PathBuf, keys: Arc<dyn KeyStore>) -> Self {
        Self {
            path,
            keys,
            vault: OnceLock::new(),
        }
    }

    /// The vault, opened now if it isn't yet. (On Android: not from the
    /// main thread, which the Kotlin side answers on.)
    pub fn get(&self) -> &Vault<T> {
        self.vault
            .get_or_init(|| Vault::open(self.path.clone(), self.keys.as_ref()))
    }
}

impl<T: Entry> Vault<T> {
    /// Opens the vault at `path` with the key from `keys` (making one if
    /// there's none). A file that can't be read is started over.
    pub fn open(path: PathBuf, keys: &dyn KeyStore) -> Self {
        let key = vault_key(keys);
        let entries = key
            .as_deref()
            .and_then(|key| {
                std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| decrypt(key, &bytes))
            })
            .unwrap_or_default();
        Self {
            path,
            key,
            entries: Mutex::new(entries),
        }
    }

    /// True if entries are kept between starts.
    pub fn persistent(&self) -> bool {
        self.key.is_some()
    }

    pub fn get(&self, key: &str) -> Option<T> {
        self.entries.lock().expect("vault lock").get(key).cloned()
    }

    pub fn all(&self) -> BTreeMap<String, T> {
        self.entries.lock().expect("vault lock").clone()
    }

    pub fn put(&self, key: &str, entry: T) {
        let mut entries = self.entries.lock().expect("vault lock");
        entries.insert(key.to_string(), entry);
        self.write(&entries);
    }

    pub fn remove(&self, key: &str) -> Option<T> {
        let mut entries = self.entries.lock().expect("vault lock");
        let removed = entries.remove(key);
        self.write(&entries);
        removed
    }

    fn write(&self, entries: &BTreeMap<String, T>) {
        let Some(key) = &self.key else { return };
        let bytes = encrypt(key, entries);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write a sibling and rename it, so a crash never leaves half a file.
        let temporary = self.path.with_extension("tmp");
        if std::fs::write(&temporary, bytes).is_ok() {
            restrict(&temporary);
            let _ = std::fs::rename(&temporary, &self.path);
        }
    }
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {}

fn encrypt<T: Serialize>(key: &[u8], entries: &BTreeMap<String, T>) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).expect("32-byte key");
    let mut nonce = [0u8; NONCE];
    rand::rng().fill_bytes(&mut nonce);
    let plain = serde_json::to_vec(entries).expect("entries serialize");
    let sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), plain.as_slice())
        .expect("encryption works");
    [MAGIC.as_slice(), &nonce, &sealed].concat()
}

fn decrypt<T: DeserializeOwned>(key: &[u8], bytes: &[u8]) -> Option<BTreeMap<String, T>> {
    let rest = bytes.strip_prefix(MAGIC.as_slice())?;
    if rest.len() < NONCE {
        return None;
    }
    let (nonce, sealed) = rest.split_at(NONCE);
    let cipher = XChaCha20Poly1305::new_from_slice(key).ok()?;
    let plain = cipher.decrypt(XNonce::from_slice(nonce), sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A keychain in memory (`None`: there's no keychain).
    struct MemoryKeys(Mutex<Option<Option<Vec<u8>>>>);

    impl KeyStore for MemoryKeys {
        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            self.0
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "no keychain".to_string())
        }
        fn save(&self, key: &[u8]) -> Result<(), String> {
            let mut slot = self.0.lock().unwrap();
            match &mut *slot {
                Some(stored) => {
                    *stored = Some(key.to_vec());
                    Ok(())
                }
                None => Err("no keychain".into()),
            }
        }
    }

    fn account() -> StoredAccount {
        StoredAccount {
            provider: Provider::Microsoft,
            client: Client {
                id: "client".into(),
                secret: None,
            },
            refresh_token: "r".repeat(3000),
            scopes: vec!["Mail.ReadWrite".into()],
            email: "max@contoso.com".into(),
            tenant: Some("t".into()),
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("action0-vault-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("accounts.vault")
    }

    #[test]
    fn keeps_accounts_encrypted_between_starts() {
        let path = temp_path("roundtrip");
        let keys = MemoryKeys(Mutex::new(Some(None)));
        let vault: Vault = Vault::open(path.clone(), &keys);
        assert!(vault.persistent());
        vault.put("microsoft:max@contoso.com", account());

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(MAGIC));
        assert!(!String::from_utf8_lossy(&bytes).contains("rrrr"));

        let again: Vault = Vault::open(path.clone(), &keys);
        assert_eq!(again.get("microsoft:max@contoso.com"), Some(account()));
        again.remove("microsoft:max@contoso.com");
        assert!(Vault::<StoredAccount>::open(path, &keys).all().is_empty());
    }

    #[test]
    fn writes_nothing_without_a_keychain() {
        let path = temp_path("nokeychain");
        let vault: Vault = Vault::open(path.clone(), &MemoryKeys(Mutex::new(None)));
        assert!(!vault.persistent());
        vault.put("gmail:a@b.c", account());
        assert_eq!(vault.get("gmail:a@b.c"), Some(account()));
        assert!(!path.exists());
    }

    #[test]
    fn starts_over_with_another_key() {
        let path = temp_path("otherkey");
        let vault: Vault = Vault::open(path.clone(), &MemoryKeys(Mutex::new(Some(None))));
        vault.put("gmail:a@b.c", account());
        let other: Vault = Vault::open(path, &MemoryKeys(Mutex::new(Some(None))));
        assert!(other.all().is_empty());
    }

    /// Counts how often the keychain is asked.
    struct CountingKeys {
        keys: MemoryKeys,
        loads: std::sync::atomic::AtomicUsize,
        saves: std::sync::atomic::AtomicUsize,
    }

    impl KeyStore for Arc<CountingKeys> {
        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            self.loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.keys.load()
        }
        fn save(&self, key: &[u8]) -> Result<(), String> {
            self.saves.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.keys.save(key)
        }
    }

    #[test]
    fn two_files_share_one_key() {
        use std::sync::atomic::Ordering;
        let accounts_path = temp_path("shared");
        let other_path = accounts_path.with_file_name("ai.vault");
        let counting = Arc::new(CountingKeys {
            keys: MemoryKeys(Mutex::new(Some(None))),
            loads: Default::default(),
            saves: Default::default(),
        });
        let shared: Arc<dyn KeyStore> = Arc::new(SharedKey::new(Box::new(counting.clone())));
        let accounts: LazyVault = LazyVault::new(accounts_path.clone(), shared.clone());
        let others: LazyVault<String> = LazyVault::new(other_path.clone(), shared);
        accounts.get().put("gmail:a@b.c", account());
        others.get().put("claude", "sk-secret".into());
        // Asked once, and only one key was made.
        assert_eq!(counting.loads.load(Ordering::SeqCst), 1);
        assert_eq!(counting.saves.load(Ordering::SeqCst), 1);
        assert!(
            !String::from_utf8_lossy(&std::fs::read(&other_path).unwrap()).contains("sk-secret")
        );

        // Next start: both open with the kept key.
        let shared: Arc<dyn KeyStore> = Arc::new(SharedKey::new(Box::new(counting.clone())));
        let accounts: Vault = Vault::open(accounts_path, shared.as_ref());
        let others: Vault<String> = Vault::open(other_path, shared.as_ref());
        assert_eq!(accounts.get("gmail:a@b.c"), Some(account()));
        assert_eq!(others.get("claude"), Some("sk-secret".into()));
        assert_eq!(counting.saves.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_shared_key_without_a_keychain_keeps_nothing() {
        let shared = SharedKey::new(Box::new(MemoryKeys(Mutex::new(None))));
        let vault: Vault<String> = Vault::open(temp_path("sharednone"), &shared);
        assert!(!vault.persistent());
    }
}
