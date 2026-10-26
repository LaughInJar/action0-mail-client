//! Spell checking in the desktop app's web view. Linux: WebKitGTK checks
//! only when asked to, in the languages it's given (through Enchant, with
//! the system's hunspell dictionaries). macOS: WebKit checks while typing
//! once the app's defaults say so. Windows: WebView2 checks in the display
//! language, and offers no way to change that.

#[cfg(any(target_os = "linux", test))]
use std::path::{Path, PathBuf};

/// The hunspell dictionaries installed on the system, as language tags
/// ("de-AT"); none outside Linux.
#[tauri::command]
pub fn spelling_dictionaries() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        dictionary_tags(&dictionary_dirs(|name| std::env::var(name).ok()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

/// Checks spelling with all of these languages at once; returns the ones
/// whose dictionaries loaded (none outside Linux).
#[tauri::command]
pub async fn spelling_set_languages(
    webview: tauri::Webview,
    languages: Vec<String>,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{WebContextExt, WebViewExt};
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                let Some(context) = platform.inner().context() else {
                    let _ = sender.send(Vec::new());
                    return;
                };
                let codes: Vec<String> =
                    languages.iter().map(|tag| tag.replace('-', "_")).collect();
                let codes: Vec<&str> = codes.iter().map(String::as_str).collect();
                context.set_spell_checking_enabled(true);
                context.set_spell_checking_languages(&codes);
                let loaded = context
                    .spell_checking_languages()
                    .iter()
                    .map(|code| code.replace('_', "-"))
                    .collect();
                let _ = sender.send(loaded);
            })
            .map_err(|e| e.to_string())?;
        receiver.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (webview, languages);
        Ok(Vec::new())
    }
}

/// macOS: WebKit checks while typing only if the app's defaults say so
/// (Safari's setting doesn't reach other apps). Before the window exists.
#[cfg(target_os = "macos")]
pub fn check_while_typing() {
    use objc2_foundation::{NSUserDefaults, ns_string};
    NSUserDefaults::standardUserDefaults()
        .setBool_forKey(true, ns_string!("WebContinuousSpellCheckingEnabled"));
}

/// Where Enchant's hunspell provider looks: the user's own folder, then
/// `hunspell/` in each of the system's data folders.
#[cfg(any(target_os = "linux", test))]
fn dictionary_dirs(env: impl Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());
    let config = non_empty("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| non_empty("HOME").map(|home| Path::new(&home).join(".config")));
    let data = non_empty("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    config
        .map(|config| config.join("enchant").join("hunspell"))
        .into_iter()
        .chain(
            data.split(':')
                .filter(|dir| !dir.is_empty())
                .map(|dir| Path::new(dir).join("hunspell")),
        )
        .collect()
}

/// "de_AT.dic" with a "de_AT.aff" next to it is "de-AT"; hyphenation,
/// thesaurus and other files are left out. Sorted, each once.
#[cfg(any(target_os = "linux", test))]
fn dictionary_tags(dirs: &[PathBuf]) -> Vec<String> {
    let mut tags: Vec<String> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()? != "dic" || !path.with_extension("aff").is_file() {
                return None;
            }
            language_tag(path.file_stem()?.to_str()?)
        })
        .collect();
    tags.sort();
    tags.dedup();
    tags
}

/// "de_AT" → "de-AT", "fr" → "fr"; anything else (`hyph_de_DE`, `th_en_US`,
/// `de_DE_frami`) isn't a language's dictionary.
#[cfg(any(target_os = "linux", test))]
fn language_tag(name: &str) -> Option<String> {
    let (language, region) = match name.split_once('_') {
        Some((language, region)) => (language, Some(region)),
        None => (name, None),
    };
    let language_ok =
        (2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase());
    let region_ok = region
        .is_none_or(|region| region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase()));
    (language_ok && region_ok).then(|| match region {
        Some(region) => format!("{language}-{region}"),
        None => language.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&str, &str)]) -> impl Fn(&str) -> Option<String> + 'a {
        |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn looks_where_enchant_looks() {
        assert_eq!(
            dictionary_dirs(env(&[("HOME", "/home/anna")])),
            [
                "/home/anna/.config/enchant/hunspell",
                "/usr/local/share/hunspell",
                "/usr/share/hunspell",
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            dictionary_dirs(env(&[
                ("HOME", "/home/anna"),
                ("XDG_CONFIG_HOME", "/cfg"),
                ("XDG_DATA_DIRS", "/app/share::/usr/share"),
            ])),
            [
                "/cfg/enchant/hunspell",
                "/app/share/hunspell",
                "/usr/share/hunspell",
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn finds_the_languages_dictionaries() {
        let base = std::env::temp_dir().join(format!("action0-dicts-{}", std::process::id()));
        let (system, user) = (base.join("system"), base.join("user"));
        std::fs::create_dir_all(&system).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        for name in [
            "de_AT.dic",
            "de_AT.aff",
            "en_US.dic",
            "en_US.aff",
            "hyph_de_DE.dic",
            "th_en_US_v2.dic",
            "fr_FR.dic",
            "README_de_AT.txt",
        ] {
            std::fs::write(system.join(name), "").unwrap();
        }
        for name in ["en_US.dic", "en_US.aff", "eo.dic", "eo.aff"] {
            std::fs::write(user.join(name), "").unwrap();
        }
        let tags = dictionary_tags(&[user, system, base.join("missing")]);
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(tags, ["de-AT", "en-US", "eo"]);
    }

    #[test]
    fn only_plain_language_names_are_tags() {
        assert_eq!(language_tag("de_CH").as_deref(), Some("de-CH"));
        assert_eq!(language_tag("ast").as_deref(), Some("ast"));
        assert_eq!(language_tag("hyph_de_DE"), None);
        assert_eq!(language_tag("de_DE_frami"), None);
        assert_eq!(language_tag("en_us"), None);
    }
}
