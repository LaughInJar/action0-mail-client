//! The Android app's own commands: files for other apps, what other apps
//! shared, notifications and the background check; and the vault's key,
//! kept by the Kotlin side in the Android Keystore.

use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_action0::{Action0, Action0Ext, FileRequest, Notice};

use crate::background;
use crate::files;
use crate::vault::KeyStore;

/// Calls the Kotlin side. It may wait for the user, so not on an async
/// worker; and never on the main thread, which it answers on.
pub async fn kotlin<T: Send + 'static>(
    app: &AppHandle,
    call: impl FnOnce(&Action0<tauri::Wry>) -> tauri_plugin_action0::Result<T> + Send + 'static,
) -> tauri_plugin_action0::Result<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || call(app.action0()))
        .await
        .map_err(|error| tauri_plugin_action0::Error {
            code: None,
            message: error.to_string(),
        })?
}

/// The vault's key, from the Android Keystore (through the Kotlin side).
pub struct KeystoreKey(pub AppHandle);

impl KeyStore for KeystoreKey {
    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        let key = self.0.action0().vault_key().map_err(|e| e.to_string())?;
        key.map(|key| STANDARD.decode(key).map_err(|e| e.to_string()))
            .transpose()
    }

    fn save(&self, key: &[u8]) -> Result<(), String> {
        self.0
            .action0()
            .save_vault_key(&STANDARD.encode(key))
            .map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileInfo {
    pub os: &'static str,
    pub version: String,
    /// The package name (`app.action0.mail`).
    pub package: String,
    /// The signing certificate's base64 SHA-1, as Google Cloud and Entra
    /// ask for it ("" if unknown).
    pub signature_hash: String,
    /// Microsoft's redirect for this build (Entra shows the same).
    pub microsoft_redirect: String,
}

#[tauri::command]
pub async fn mobile_info(app: AppHandle) -> Result<MobileInfo, String> {
    let signature_hash = kotlin(&app, |side| side.signature_hash())
        .await
        .unwrap_or_default();
    let package = app.config().identifier.clone();
    Ok(MobileInfo {
        os: std::env::consts::OS,
        version: app.package_info().version.to_string(),
        microsoft_redirect: crate::oauth::providers::msauth_redirect(&package, &signature_hash),
        package,
        signature_hash,
    })
}

/// A file the UI sent, written to the cache, for the Kotlin side.
async fn with_file(
    app: &AppHandle,
    request: &Request<'_>,
    call: impl FnOnce(&Action0<tauri::Wry>, &FileRequest<'_>) -> tauri_plugin_action0::Result<bool>
    + Send
    + 'static,
) -> Result<bool, String> {
    let file = files::write(app, request)?;
    kotlin(app, move |side| {
        let path = file.path.to_string_lossy();
        call(
            side,
            &FileRequest {
                path: &path,
                name: &file.name,
                mime_type: &file.mime_type,
            },
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Opens a file (raw body; name and type in `x-a0-name`, `x-a0-type`) with
/// another app.
#[tauri::command]
pub async fn mobile_open_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    with_file(&app, &request, |side, file| {
        side.open_file(file).map(|()| true)
    })
    .await
    .map(|_| ())
}

/// Offers a file to other apps (the share sheet).
#[tauri::command]
pub async fn mobile_share_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    with_file(&app, &request, |side, file| {
        side.share_file(file).map(|()| true)
    })
    .await
    .map(|_| ())
}

/// Lets the user save a file where they like; false if they cancelled.
#[tauri::command]
pub async fn mobile_save_file(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    with_file(&app, &request, |side, file| side.save_file(file)).await
}

/// A file another app shared (copied into the cache by the Kotlin side),
/// handed over once and deleted.
#[tauri::command]
pub fn mobile_read_shared(app: AppHandle, path: String) -> Result<Response, String> {
    let shared = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("shared");
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The shared file is gone.".to_string())?;
    let inside = shared
        .canonicalize()
        .map(|shared| path.starts_with(shared))
        .unwrap_or(false);
    if !inside {
        return Err("Not a shared file.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    if let Some(folder) = path.parent() {
        // Only once it's empty (the share's other files are still to come).
        let _ = std::fs::remove_dir(folder);
    }
    Ok(Response::new(bytes))
}

/// Shows a notification; tapping it opens `url` (an `action0://open` link).
#[tauri::command]
pub async fn mobile_notify(
    app: AppHandle,
    tag: String,
    title: String,
    body: String,
    url: String,
) -> Result<(), String> {
    kotlin(&app, move |side| {
        side.notify(&Notice {
            tag: &tag,
            title: &title,
            body: &body,
            url: &url,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// `granted`, `denied` or `prompt`; with `ask`, asks the user first if it may.
#[tauri::command]
pub async fn mobile_notification_permission(app: AppHandle, ask: bool) -> Result<String, String> {
    kotlin(&app, move |side| side.notification_permission(ask))
        .await
        .map_err(|e| e.to_string())
}

/// Turns the background check on or off, with the notifications' texts
/// in the UI's language.
#[tauri::command]
pub async fn mobile_configure_background(
    app: AppHandle,
    enabled: bool,
    texts: background::Texts,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    background::configure(&dir, enabled, texts)?;
    kotlin(&app, move |side| side.schedule_checks(enabled))
        .await
        .map_err(|e| e.to_string())
}

/// The system bars follow the app's theme (light or dark, and the page's
/// background below it).
#[tauri::command]
pub async fn mobile_set_theme(
    app: AppHandle,
    dark: bool,
    background: String,
) -> Result<(), String> {
    kotlin(&app, move |side| side.set_theme(dark, &background))
        .await
        .map_err(|e| e.to_string())
}
