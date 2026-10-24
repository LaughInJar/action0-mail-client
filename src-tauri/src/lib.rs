//! action0's desktop shell: the web UI in a native window, with sign-in,
//! networking and desktop integration done here.

mod net;
pub mod oauth;
mod shell;
mod vault;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

pub fn run() {
    // reqwest and the updater share rustls; it needs one crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let hidden_start = std::env::args().any(|arg| arg == shell::HIDDEN_ARG);

    tauri::Builder::default()
        // First, so a second start reaches the running app before anything else.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            shell::on_second_instance(app, args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
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
        .setup(|app| {
            let http = net::http_client();
            let vault_path = app.path().app_data_dir()?.join("accounts.vault");
            let keys = vault::OsKeyStore {
                service: app.config().identifier.clone(),
            };
            app.manage(oauth::Auth::new(
                http.clone(),
                vault::Vault::open(vault_path, &keys),
            ));
            app.manage(net::Requests::new(http));
            shell::clear_open_folder(app.handle());
            shell::setup(app.handle())?;
            Ok(())
        })
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
        ])
        .build(tauri::generate_context!())
        .expect("action0 starts")
        .run(shell::on_run_event);
}
