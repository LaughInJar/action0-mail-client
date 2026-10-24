//! How action0 lives on the desktop: one instance, a window that hides to
//! the tray instead of closing, a tray menu, the unread count on the icon,
//! `mailto:` links, and a "check now" tick while the window is hidden
//! (hidden web views may throttle their own timers).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use tauri::image::Image;
use tauri::ipc::Request;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Window, WindowEvent, Wry};

/// Started by the system (autostart): stay in the tray.
pub const HIDDEN_ARG: &str = "--hidden";
/// How often the UI is asked to check for mail while hidden.
const POLL_EVERY: Duration = Duration::from_secs(5 * 60);

/// Events for the UI.
pub const EVENT_POLL: &str = "a0://poll";
pub const EVENT_COMPOSE: &str = "a0://compose";
pub const EVENT_CLOSED_TO_TRAY: &str = "a0://closed-to-tray";

pub struct Shell {
    close_to_tray: AtomicBool,
    /// `mailto:` links that came before the UI asked for them.
    pending: Mutex<Vec<String>>,
    /// The UI took the pending links: later ones only go out as events.
    ui_ready: AtomicBool,
    tray: Mutex<Option<TrayParts>>,
    hidden_start: bool,
}

struct TrayParts {
    icon: TrayIcon,
    show: MenuItem<Wry>,
    compose: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

impl Shell {
    pub fn new(hidden_start: bool) -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            pending: Mutex::new(Vec::new()),
            ui_ready: AtomicBool::new(false),
            tray: Mutex::new(None),
            hidden_start,
        }
    }
}

/// The `mailto:` links among command-line arguments (how Windows passes them).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn mailto_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| arg.to_ascii_lowercase().starts_with("mailto:"))
        .cloned()
        .collect()
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hands a `mailto:` link to the UI (or keeps it until the UI asks).
pub fn compose(app: &AppHandle, url: String) {
    show(app);
    let shell = app.state::<Shell>();
    if shell.ui_ready.load(Ordering::Acquire) {
        let _ = app.emit(EVENT_COMPOSE, url);
    } else {
        shell.pending.lock().expect("shell lock").push(url);
    }
}

/// A second start (a click on the launcher, a `mailto:` link): the first
/// instance shows itself. `mailto:` links arrive through the deep-link
/// plugin on Linux and macOS; Windows (where action0 is chosen as a mail
/// app instead of registering the scheme) passes them as arguments.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    show(app);
    #[cfg(target_os = "windows")]
    for link in mailto_args(&args) {
        compose(app, link);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = args;
}

/// Sets up the tray, the hidden-window tick, and the first window.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let show_item = MenuItem::with_id(app, "show", "Show action0", true, None::<&str>)?;
    let compose_item = MenuItem::with_id(app, "compose", "New mail", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &compose_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("action0")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "compose" => compose(app, String::new()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    *shell.tray.lock().expect("shell lock") = Some(TrayParts {
        icon,
        show: show_item,
        compose: compose_item,
        quit: quit_item,
    });

    // mailto: links of the first start, and later ones.
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        shell
            .pending
            .lock()
            .expect("shell lock")
            .extend(mailto_args(&args));
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let links = |urls: Vec<url::Url>| {
            urls.into_iter()
                .filter(|url| url.scheme() == "mailto")
                .map(String::from)
                .collect::<Vec<_>>()
        };
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            shell
                .pending
                .lock()
                .expect("shell lock")
                .extend(links(urls));
        }
        let handle = app.clone();
        app.deep_link().on_open_url(move |event| {
            for link in links(event.urls()) {
                compose(&handle, link);
            }
        });
    }

    if !shell.hidden_start {
        show(app);
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(POLL_EVERY);
        tick.tick().await;
        loop {
            tick.tick().await;
            let hidden = handle
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .is_some_and(|visible| !visible);
            if hidden {
                let _ = handle.emit(EVENT_POLL, ());
            }
        }
    });
    Ok(())
}

/// Closing the window hides it to the tray (unless the user turned that off).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let shell = window.state::<Shell>();
        if shell.close_to_tray.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.emit(EVENT_CLOSED_TO_TRAY, ());
        }
    }
}

/// macOS: clicking the dock icon of a hidden app shows it again.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        show(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Texts of the tray menu, in the interface's language.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTexts {
    pub show: String,
    pub compose: String,
    pub quit: String,
}

/// What the UI tells the shell: the close-to-tray setting and the menu texts.
#[tauri::command]
pub fn shell_configure(shell: State<'_, Shell>, close_to_tray: bool, texts: TrayTexts) {
    shell.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    if let Some(tray) = shell.tray.lock().expect("shell lock").as_ref() {
        let _ = tray.show.set_text(texts.show);
        let _ = tray.compose.set_text(texts.compose);
        let _ = tray.quit.set_text(texts.quit);
    }
}

/// The unread count on the icons: the dock/launcher badge where there is
/// one, an overlay on Windows' taskbar (a PNG the UI drew), and the tray
/// (a label next to it on Linux and macOS, the tooltip elsewhere).
#[tauri::command]
pub fn shell_set_unread(
    window: Window,
    shell: State<'_, Shell>,
    count: u32,
    tooltip: String,
    overlay: Option<Vec<u8>>,
) {
    let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
    #[cfg(target_os = "windows")]
    {
        let image = overlay.and_then(|png| Image::from_bytes(&png).ok());
        let _ = window.set_overlay_icon(image);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = overlay;
    if let Some(tray) = shell.tray.lock().expect("shell lock").as_ref() {
        let _ = tray.icon.set_tooltip(Some(tooltip));
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let _ = tray.icon.set_title((count > 0).then(|| count.to_string()));
    }
}

/// `mailto:` links that arrived before the UI was ready; later ones come
/// as events.
#[tauri::command]
pub fn shell_take_compose(shell: State<'_, Shell>) -> Vec<String> {
    let mut pending = shell.pending.lock().expect("shell lock");
    shell.ui_ready.store(true, Ordering::Release);
    std::mem::take(&mut *pending)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub os: &'static str,
    pub version: String,
    pub hidden_start: bool,
}

#[tauri::command]
pub fn shell_info(app: AppHandle, shell: State<'_, Shell>) -> ShellInfo {
    ShellInfo {
        os: std::env::consts::OS,
        version: app.package_info().version.to_string(),
        hidden_start: shell.hidden_start,
    }
}

/// Quits for real (the tray menu and Ctrl/⌘+Q).
#[tauri::command]
pub fn shell_quit(app: AppHandle) {
    app.exit(0);
}

/// How making action0 the default mail app went. (Each platform has one.)
#[derive(Serialize)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub enum DefaultMailApp {
    /// It is now (Linux).
    Done,
    /// The system's settings opened to choose it (Windows).
    Settings,
    /// The user has to choose it in the system (macOS: in Mail's settings).
    Manual,
}

#[tauri::command]
pub fn shell_default_mail_app(app: AppHandle) -> Result<DefaultMailApp, String> {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .register("mailto")
            .map_err(|e| e.to_string())?;
        Ok(DefaultMailApp::Done)
    }
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url("ms-settings:defaultapps", None::<&str>)
            .map_err(|e| e.to_string())?;
        Ok(DefaultMailApp::Settings)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(DefaultMailApp::Manual)
    }
}

/// Opens a file (raw body; its name in `x-a0-name`) with the system's app
/// for it, e.g. a PDF viewer.
#[tauri::command]
pub fn shell_open_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = crate::files::write(&app, &request)?;
    app.opener()
        .open_path(file.path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_mailto_links_among_arguments() {
        let args = vec![
            "action0.exe".to_string(),
            "MAILTO:anna@example.org?subject=Hi".into(),
            "--hidden".into(),
        ];
        assert_eq!(
            mailto_args(&args),
            vec!["MAILTO:anna@example.org?subject=Hi"]
        );
    }
}
