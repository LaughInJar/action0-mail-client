/// Commands the UI may call on the Kotlin side directly (everything else
/// goes through the app's own commands, in Rust).
const COMMANDS: &[&str] = &["pending", "insets", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
