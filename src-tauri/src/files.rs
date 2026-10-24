//! Files the UI hands to other apps (a PDF to open, an attachment to share
//! or save): written to the app's cache, which is emptied at every start so
//! mail content doesn't pile up on disk.

use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime};

/// The cache folder for handed-over files.
fn folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("open"))
}

/// Empties the folder (at start).
pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    if let Some(folder) = folder(app) {
        let _ = std::fs::remove_dir_all(folder);
    }
}

/// A file the UI sent: written to the cache.
#[cfg_attr(desktop, allow(dead_code))]
pub struct Written {
    pub path: PathBuf,
    pub name: String,
    /// `x-a0-type`, else `application/octet-stream`.
    pub mime_type: String,
}

/// Writes a request's raw body (the name in `x-a0-name`, the type in
/// `x-a0-type`, both percent-encoded) to a folder of its own in the cache.
pub fn write<R: Runtime>(app: &AppHandle<R>, request: &Request<'_>) -> Result<Written, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file came.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                percent_encoding::percent_decode_str(value)
                    .decode_utf8_lossy()
                    .into_owned()
            })
    };
    let name = header("x-a0-name").unwrap_or_else(|| "file".into());
    let mime_type = header("x-a0-type")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "application/octet-stream".into());
    let folder = folder(app)
        .ok_or_else(|| "No folder for files.".to_string())?
        .join(crate::oauth::pkce::random_token(6));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Written {
        path,
        name,
        mime_type,
    })
}

/// A file name without folders or characters file systems refuse.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_file_names_inside_their_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("Report Q3.pdf"), "Report Q3.pdf");
        assert_eq!(safe_name(".."), "file");
    }
}
