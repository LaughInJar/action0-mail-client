//! action0's native side: the web UI in a desktop window or an Android
//! app, with sign-in, networking and the platform integration done here.

mod background;
mod files;
#[cfg(target_os = "android")]
mod mobile;
mod net;
pub mod oauth;
#[cfg(desktop)]
mod shell;
mod vault;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest (and the updater) use rustls; it needs one crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop_plugins(builder);
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_action0::init());

    let app = builder.plugin(tauri_plugin_opener::init()).setup(|app| {
        let http = net::http_client();
        let vault_path = app.path().app_data_dir()?.join("accounts.vault");
        #[cfg(desktop)]
        let keys = Box::new(vault::OsKeyStore {
            service: app.config().identifier.clone(),
        });
        #[cfg(target_os = "android")]
        let keys = Box::new(mobile::KeystoreKey(app.handle().clone()));
        app.manage(oauth::Auth::new(
            http.clone(),
            vault::LazyVault::new(vault_path, keys),
        ));
        app.manage(net::Requests::new(http));
        files::clear(app.handle());
        #[cfg(desktop)]
        shell::setup(app.handle())?;
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
            shell::shell_configure,
            shell::shell_set_unread,
            shell::shell_take_compose,
            shell::shell_info,
            shell::shell_quit,
            shell::shell_default_mail_app,
            shell::shell_open_file,
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
