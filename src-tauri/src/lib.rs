//! action0's native side: the web UI in a desktop window or an Android
//! app, with sign-in, networking and the platform integration done here.

mod ai;
mod background;
pub mod caldav;
mod files;
pub mod imap;
#[cfg(target_os = "android")]
mod mobile;
mod net;
pub mod oauth;
#[cfg(desktop)]
mod shell;
#[cfg(desktop)]
mod spelling;
mod vault;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest (and the updater) use rustls; it needs one crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(target_os = "macos")]
    spelling::check_while_typing();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop_plugins(builder);
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_action0::init());

    let app = builder.plugin(tauri_plugin_opener::init()).setup(|app| {
        let http = net::http_client();
        let data = app.path().app_data_dir()?;
        #[cfg(desktop)]
        let keys = Box::new(vault::OsKeyStore {
            service: app.config().identifier.clone(),
        });
        #[cfg(target_os = "android")]
        let keys = Box::new(mobile::KeystoreKey(app.handle().clone()));
        // The accounts, IMAP accounts, calendar servers and the AI
        // assistant's keys: four files, one key.
        let keys: std::sync::Arc<dyn vault::KeyStore> =
            std::sync::Arc::new(vault::SharedKey::new(keys));
        app.manage(oauth::Auth::new(
            http.clone(),
            vault::LazyVault::new(data.join("accounts.vault"), keys.clone()),
        ));
        app.manage(imap::Imap::new(
            http.clone(),
            vault::LazyVault::new(data.join("imap.vault"), keys.clone()),
        ));
        app.manage(caldav::Caldav::new(vault::LazyVault::new(
            data.join("caldav.vault"),
            keys.clone(),
        )));
        app.manage(ai::Ai::new(
            http.clone(),
            vault::LazyVault::new(data.join("ai.vault"), keys),
        ));
        app.manage(net::Requests::new(http));
        files::clear(app.handle());
        #[cfg(desktop)]
        shell::setup(app.handle())?;
        // IDLE on the IMAP accounts' Inboxes.
        #[cfg(desktop)]
        imap::watch_inboxes(app.handle());
        Ok(())
    });

    #[cfg(desktop)]
    let app = app
        .on_window_event(shell::on_window_event)
        .invoke_handler(tauri::generate_handler![
            net::net_fetch,
            net::net_abort,
            oauth::auth_accounts,
            oauth::auth_connect,
            oauth::auth_sign_in,
            oauth::auth_token,
            oauth::auth_sign_out,
            ai::ai_secrets,
            ai::ai_save_key,
            ai::ai_forget,
            ai::ai_request,
            ai::ai_abort,
            ai::ai_openrouter_sign_in,
            ai::ai_chatgpt_sign_in,
            imap::imap_discover,
            imap::imap_connect,
            imap::imap_accounts,
            imap::imap_reconnect,
            imap::imap_remove,
            imap::imap_forget_certificate,
            imap::imap_send,
            imap::imap_call,
            imap::imap_bytes,
            imap::imap_append,
            caldav::caldav_discover,
            caldav::caldav_connect,
            caldav::caldav_servers,
            caldav::caldav_remove,
            caldav::caldav_forget_certificate,
            caldav::caldav_request,
            caldav::caldav_abort,
            shell::shell_configure,
            shell::shell_set_unread,
            shell::shell_take_compose,
            shell::shell_info,
            shell::shell_quit,
            shell::shell_default_mail_app,
            shell::shell_open_file,
            spelling::spelling_dictionaries,
            spelling::spelling_set_languages,
        ]);
    #[cfg(target_os = "android")]
    let app = app.invoke_handler(tauri::generate_handler![
        net::net_fetch,
        net::net_abort,
        oauth::auth_accounts,
        oauth::auth_connect,
        oauth::auth_sign_in,
        oauth::auth_token,
        oauth::auth_sign_out,
        ai::ai_secrets,
        ai::ai_save_key,
        ai::ai_forget,
        ai::ai_request,
        ai::ai_abort,
        ai::ai_openrouter_sign_in,
        ai::ai_chatgpt_sign_in,
        imap::imap_discover,
        imap::imap_connect,
        imap::imap_accounts,
        imap::imap_reconnect,
        imap::imap_remove,
        imap::imap_forget_certificate,
        imap::imap_send,
        imap::imap_call,
        imap::imap_bytes,
        imap::imap_append,
        caldav::caldav_discover,
        caldav::caldav_connect,
        caldav::caldav_servers,
        caldav::caldav_remove,
        caldav::caldav_forget_certificate,
        caldav::caldav_request,
        caldav::caldav_abort,
        mobile::mobile_info,
        mobile::mobile_open_file,
        mobile::mobile_share_file,
        mobile::mobile_save_file,
        mobile::mobile_read_shared,
        mobile::mobile_notify,
        mobile::mobile_notification_permission,
        mobile::mobile_configure_background,
        mobile::mobile_set_theme,
    ]);

    let app = app
        .build(tauri::generate_context!())
        .expect("action0 starts");
    #[cfg(desktop)]
    app.run(shell::on_run_event);
    #[cfg(not(desktop))]
    app.run(|_, _| {});
}

/// The plugins only the desktop app has: one instance, `mailto:` links,
/// files and dialogs, notifications, autostart, updates, window state.
#[cfg(desktop)]
fn desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tauri_plugin_autostart::MacosLauncher;
    use tauri_plugin_window_state::StateFlags;
    let hidden_start = std::env::args().any(|arg| arg == shell::HIDDEN_ARG);
    builder
        // First, so a second start reaches the running app before anything else.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            shell::on_second_instance(app, args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![shell::HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility is ours: hidden at start, hidden in the tray.
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .manage(shell::Shell::new(hidden_start))
}
