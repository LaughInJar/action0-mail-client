package app.action0.plugin

/** The background check's Rust side (`src-tauri/src/background.rs`, JNI). */
object Native {
  @Volatile private var loaded = false

  /** Loads the app's Rust library (a no-op if the app has already). */
  fun load() {
    if (!loaded) {
      System.loadLibrary("action0_lib")
      loaded = true
    }
  }

  /** The signed-in accounts: JSON `[{key, provider, email, scopes}]`. */
  @JvmStatic external fun accounts(dataDir: String, vaultKey: String): String

  /**
   * Checks for new mail. `googleTokens` is JSON `{accountKey: accessToken}`;
   * returns JSON `[{tag, title, body, url}]`, the notifications to show.
   */
  @JvmStatic external fun check(dataDir: String, vaultKey: String, googleTokens: String): String
}
