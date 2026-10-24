//! action0's Android side, in Kotlin (`android/`): Google sign-in through
//! Play services, the browser tab for other sign-ins, the vault's key in
//! the Android Keystore, opening, sharing and saving files, notifications,
//! incoming links and shares, and the background mail check. This crate is
//! the Rust API the app calls it through; on other platforms it's empty.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{
    Manager, Runtime,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

/// Why a call to the Kotlin side failed.
#[derive(Debug)]
pub struct Error {
    /// What the Kotlin side called it: `cancelled`, `interaction`,
    /// `noPlayServices`, `denied`, `network`, `noApp`, … (`None`: something else).
    pub code: Option<String>,
    pub message: String,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl From<tauri::plugin::mobile::PluginInvokeError> for Error {
    fn from(error: tauri::plugin::mobile::PluginInvokeError) -> Self {
        use tauri::plugin::mobile::PluginInvokeError;
        match error {
            PluginInvokeError::InvokeRejected(response) => Self {
                message: response
                    .message
                    .clone()
                    .unwrap_or_else(|| response.to_string()),
                code: response.code,
            },
            other => Self {
                code: None,
                message: other.to_string(),
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// An access token from Google Play services.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleToken {
    pub access_token: String,
    /// The scopes granted (Play services may grant fewer than asked).
    pub granted_scopes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleRequest<'a> {
    scopes: &'a [String],
    account: Option<&'a str>,
    /// Show Google's consent screen if needed; else fail with "interaction".
    interactive: bool,
}

#[derive(Deserialize)]
struct Value<T> {
    value: T,
}

/// A file for another app.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest<'a> {
    pub path: &'a str,
    pub name: &'a str,
    pub mime_type: &'a str,
}

/// A notification; tapping it opens `url` (an `action0://` link).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice<'a> {
    pub tag: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub url: &'a str,
}

/// The Kotlin side, from Rust.
pub struct Action0<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

#[cfg(any(target_os = "android", target_os = "ios"))]
impl<R: Runtime> Action0<R> {
    fn call<T: DeserializeOwned>(&self, command: &str, args: impl Serialize) -> Result<T> {
        Ok(self.0.run_mobile_plugin(command, args)?)
    }

    /// An access token for a Google account (`account` empty: let the
    /// user pick one), from Play services.
    pub fn google_authorize(
        &self,
        scopes: &[String],
        account: Option<&str>,
        interactive: bool,
    ) -> Result<GoogleToken> {
        self.call(
            "googleAuthorize",
            GoogleRequest {
                scopes,
                account,
                interactive,
            },
        )
    }

    /// Forgets a token Play services handed out (signing out).
    pub fn google_clear(&self, token: &str) -> Result<()> {
        self.call("googleClear", serde_json::json!({ "token": token }))
    }

    /// Opens `url` in a browser tab and waits until the browser comes back
    /// to a link starting with `redirect`; that link. Fails when the tab
    /// is closed first.
    pub fn auth_tab(&self, url: &str, redirect: &str) -> Result<String> {
        self.call::<Value<String>>(
            "authTab",
            serde_json::json!({ "url": url, "redirect": redirect }),
        )
        .map(|answer| answer.value)
    }

    /// The app's signing certificate as base64 SHA-1 (Microsoft's redirect).
    pub fn signature_hash(&self) -> Result<String> {
        self.call::<Value<String>>("signatureHash", ())
            .map(|answer| answer.value)
    }

    /// The vault's key, kept wrapped by the Android Keystore (none yet: `None`).
    pub fn vault_key(&self) -> Result<Option<String>> {
        self.call::<Value<Option<String>>>("vaultKey", ())
            .map(|answer| answer.value)
    }

    /// Keeps the vault's key (base64).
    pub fn save_vault_key(&self, key: &str) -> Result<()> {
        self.call("saveVaultKey", serde_json::json!({ "key": key }))
    }

    /// Opens a file with another app ("Open with").
    pub fn open_file(&self, file: &FileRequest<'_>) -> Result<()> {
        self.call("openFile", file)
    }

    /// Offers a file to other apps (the share sheet).
    pub fn share_file(&self, file: &FileRequest<'_>) -> Result<()> {
        self.call("shareFile", file)
    }

    /// Lets the user save a file where they like ("Save to…"); false if
    /// they cancelled.
    pub fn save_file(&self, file: &FileRequest<'_>) -> Result<bool> {
        self.call::<Value<bool>>("saveFile", file)
            .map(|answer| answer.value)
    }

    /// Shows a notification.
    pub fn notify(&self, notice: &Notice<'_>) -> Result<()> {
        self.call("notify", notice)
    }

    /// `granted`, `denied` or `prompt`; with `ask`, asks first if it may.
    pub fn notification_permission(&self, ask: bool) -> Result<String> {
        self.call::<Value<String>>("notificationPermission", serde_json::json!({ "ask": ask }))
            .map(|answer| answer.value)
    }

    /// The system bars follow the app's theme; `background` ("#rrggbb")
    /// shows below the page.
    pub fn set_theme(&self, dark: bool, background: &str) -> Result<()> {
        self.call(
            "setTheme",
            serde_json::json!({ "dark": dark, "background": background }),
        )
    }

    /// Starts or stops the periodic background check.
    pub fn schedule_checks(&self, enabled: bool) -> Result<()> {
        self.call("scheduleChecks", serde_json::json!({ "enabled": enabled }))
    }
}

/// Access to [Action0] from an app handle.
pub trait Action0Ext<R: Runtime> {
    fn action0(&self) -> &Action0<R>;
}

impl<R: Runtime, T: Manager<R>> Action0Ext<R> for T {
    fn action0(&self) -> &Action0<R> {
        self.state::<Action0<R>>().inner()
    }
}

/// The plugin. On Android it registers the Kotlin class; elsewhere it does nothing.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("action0")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("app.action0.plugin", "Action0Plugin")?;
                _app.manage(Action0(handle));
            }
            Ok(())
        })
        .build()
}
