# The Android app

The Android app is the desktop app's Tauri project with an Android target: the same React UI (in its phone layout) and the same Rust side, plus a small Kotlin plugin for what only Android can do. This document describes what differs from the desktop app; the shared parts (networking, the vault, the sign-in bridge, IPC conventions) are in [desktop-app.md](desktop-app.md). User-facing features and the OAuth registrations are in the [README](../README.md#android-app); the reasons in [decisions.md](decisions.md) and the decisions log.

- [Overview](#overview)
- [Rust: what's shared, what's Android's](#rust-whats-shared-whats-androids)
- [The Kotlin plugin](#the-kotlin-plugin)
- [Sign-in](#sign-in)
- [The vault's key](#the-vaults-key)
- [The background check](#the-background-check)
- [Phone integration](#phone-integration)
- [The Platform](#the-platform)
- [Building, running and debugging](#building-running-and-debugging)
- [Limits](#limits)

## Overview

```
┌──────────── web view (dist/) ────────────┐      ┌──── Rust (libaction0_lib.so) ────┐      ┌──── Kotlin (plugins/action0) ────┐
│ React UI ── Platform (native/android.ts) ┼─IPC─▶│ mobile.rs  files, notices, theme ┼─────▶│ Action0Plugin: Play services,     │
│          ── NativeAuthSession ───────────┼─IPC─▶│ oauth/     sign-in, tokens       ┼─────▶│ Custom Tabs, Keystore, intents,   │
│ providers ── nativeFetch ────────────────┼─IPC─▶│ net.rs     HTTP (reqwest)        │      │ files, notifications, WorkManager │
│          ◀── events: incoming, insets ───┼──────┼──────────────────────────────────┼──────┤                                   │
└──────────────────────────────────────────┘      │ background.rs ◀──── JNI ─────────┼──────┤ MailCheckWorker (no web view)     │
                                                  └──────────────────────────────────┘      └───────────────────────────────────┘
```

- The generated Android project lives in `src-tauri/gen/android/` and is committed with our edits: `MainActivity.kt` (edge to edge), the intent filters in `AndroidManifest.xml` (`msauth://`, `mailto:`, Share), `res/xml/file_paths.xml` (only the cache is shared with other apps), SDK levels 36 and the release signing from `keystore.properties` in `app/build.gradle.kts`. Tauri regenerates `tauri.build.gradle.kts`, `tauri.settings.gradle` and `app/src/main/java/…/generated/` on every build (git-ignored).
- The app's package is the Tauri identifier, `app.action0.mail`.
- `src/main.tsx` detects the app (`"__TAURI_INTERNALS__" in window`) and calls `startNative()` (`src/platform/native/index.ts`), which loads `android.ts` when the user agent says Android, else `desktop.ts`.

## Rust: what's shared, what's Android's

`src-tauri/src/lib.rs` has one `run()` for both: `#[cfg_attr(mobile, tauri::mobile_entry_point)]` makes it the Android entry point. Desktop-only plugins (single instance, deep link, dialog, fs, notification, autostart, updater, process, window state) and `shell.rs` (tray, window, `mailto:` arguments) are behind `#[cfg(desktop)]`; their crates are desktop-only dependencies in `Cargo.toml`. Android gets `tauri-plugin-action0` (the Kotlin side), `jni` and `webpki-roots`.

| File                  | On Android                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `net.rs`              | The same `net_fetch`. TLS uses Mozilla's root certificates compiled in (`android_tls()`), because rustls' platform verifier would need its own Java side wired up. User-installed CAs aren't trusted.        |
| `vault.rs`            | The same encrypted file. Opened lazily (`LazyVault`) on the first auth command, because its key comes from the Kotlin side, which can only be asked once the app runs.                                       |
| `oauth/`              | Microsoft: the browser round trip with an `msauth://` redirect instead of the loopback (`round_trip`). Google: Play services instead of the browser (`play_sign_in`, `play_token`). See [Sign-in](#sign-in). |
| `files.rs`            | Shared: writes a file the UI sends (raw body, name and type in headers) into the cache's `open/` folder, emptied at every start.                                                                             |
| `mobile.rs` (Android) | The `mobile_*` commands, `KeystoreKey` (the vault's key store), and `kotlin()`, which calls the Kotlin side on a blocking thread.                                                                            |
| `background.rs`       | The background check's logic (compiled everywhere, so it's tested on desktop) and its JNI entry points (Android only).                                                                                       |

**Threads.** The Kotlin side answers on the main thread, and synchronous Tauri commands run on it too. So every call into Kotlin goes through `mobile::kotlin()` (`spawn_blocking`) from an async command, and `auth_accounts` became async (it opens the vault).

Commands only the Android app registers:

| Command                          | What it does                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `mobile_info`                    | Version, OS, package, signing certificate's base64 SHA-1 and Microsoft's redirect for it           |
| `mobile_open_file`               | Writes the file to the cache and opens it with another app (`openFile`)                            |
| `mobile_share_file`              | The same, offered to other apps (`shareFile`, the share sheet)                                     |
| `mobile_save_file`               | The same, saved where the user picks (`saveFile`, "Save to…"); false if cancelled                  |
| `mobile_read_shared`             | Hands over a file another app shared (copied into `cache/shared/` by Kotlin) once, then deletes it |
| `mobile_notify`                  | Shows a notification whose tap opens an `action0://open` link                                      |
| `mobile_notification_permission` | `granted`, `denied` or `prompt`; with `ask`, asks first (Android 13+)                              |
| `mobile_configure_background`    | Saves the background check's on/off and texts, and schedules or cancels it                         |
| `mobile_set_theme`               | Status and navigation bar icons, and the window background below the page, follow the theme        |

## The Kotlin plugin

`src-tauri/plugins/action0/` is a Tauri plugin crate whose `android/` folder is a Gradle library (namespace `app.action0.plugin`, Play services auth, `androidx.browser`, WorkManager). `src/lib.rs` is the Rust API the app calls it through (`Action0Ext::action0()`, then `google_authorize`, `auth_tab`, `vault_key`, …, each a `run_mobile_plugin` call); on other platforms the plugin does nothing.

| Kotlin             | What it does                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Action0Plugin.kt` | The commands (below), incoming intents, the insets and the sign-in tab's lifecycle                                                          |
| `VaultKey.kt`      | The vault's key, encrypted with an AES-256-GCM key that lives in the Android Keystore, stored in the app's preferences                      |
| `Notifications.kt` | The "New mail" channel and notifications; a tap starts the app's own launch activity with the `action0://` link (no other app can catch it) |
| `Background.kt`    | `Background.schedule()` (WorkManager, every 15 minutes with a network) and `MailCheckWorker`                                                |
| `Native.kt`        | The JNI functions of `background.rs` (`accounts`, `check`) and loading `libaction0_lib.so`                                                  |
| `AppState.kt`      | Whether the app is in front (the worker leaves it to the app then)                                                                          |

Commands Rust calls: `googleAuthorize`, `googleClear`, `authTab`, `signatureHash`, `vaultKey`, `saveVaultKey`, `openFile`, `shareFile`, `saveFile`, `notify`, `notificationPermission`, `setTheme`, `scheduleChecks`. Commands the UI calls directly (they're the only ones in the plugin's `permissions/default.toml` and in `capabilities/android.json`): `pending` (links and shares that arrived before the UI listened) and `insets`, plus listening for the `incoming` and `insets` events. Rejections carry a code (`cancelled`, `interaction`, `noPlayServices`, `denied`, `network`, `noApp`) that Rust maps to the UI's error kinds.

## Sign-in

**Google: Play services.** `googleAuthorize` uses `Identity.getAuthorizationClient(…).authorize()` with the scopes (and the account, once known). If Google needs the user (account choice, consent), it returns a pending intent: shown when `interactive`, otherwise rejected as `interaction`, which Rust turns into "sign in again". The result is an access token and the granted scopes, no refresh token: `play_token()` asks again silently when the token (taken to last 50 minutes) runs low. The address comes from Gmail's `users/me/profile`. The vault keeps the account with the client id `play-services` and no refresh token; signing out clears the token in Play services and revokes the grant with the access token. Google identifies the app by package and signing certificate (an Android OAuth client in Google Cloud), so the app has no client ID; `createGoogleAndroidSetup()` makes the wizard skip that step. Error 10 (`DEVELOPER_ERROR`) means that client is missing.

**Microsoft: a Custom Tab.** `round_trip()` builds the redirect `msauth://app.action0.mail/<URL-encoded signature hash>` (`providers::msauth_redirect`), the authorize URL with PKCE and state as on the desktop, and calls `authTab`. The Kotlin side opens a Custom Tab and keeps the invoke pending; the `msauth://` intent filter brings the answer back to `MainActivity`, `onNewIntent` matches it against the redirect and resolves. If the app comes back to the front without it, the tab was closed: rejected as `cancelled` after a short delay. The code is redeemed in Rust and the refresh token kept in the vault, exactly like on the desktop. Custom schemes can be claimed by other apps; PKCE and the state check keep a caught code useless.

## The vault's key

`KeystoreKey` (in `mobile.rs`) implements the vault's `KeyStore` with `vaultKey`/`saveVaultKey`. `VaultKey.kt` keeps the 32-byte key encrypted (AES-GCM, IV first) in the app's preferences, with a key that's generated in and never leaves the Android Keystore (`action0-vault`). Rust's `keyring` crate has no Android store in its simple mode, and doing it in Kotlin lets the background worker pass the key to Rust without a second route.

## The background check

`mobile_configure_background` writes `background.json` (in the app's data folder): on/off and the notification texts in the UI's language. `AndroidIntegration` calls it whenever the notifications setting or the language changes. `Background.schedule()` keeps a unique periodic WorkManager job (`action0-mail-check`, 15 minutes, needs a network; Android decides when it really runs).

`MailCheckWorker.doWork()`:

1. Does nothing while the app is in front (`AppState.foreground`): the UI's own sync covers it.
2. Reads the vault's key (`VaultKey`), loads the Rust library and asks `Native.accounts()` for the accounts (keys, providers, addresses, scopes; no tokens).
3. Gets each Google account's token from Play services, silently; an account that needs the user is skipped until the app is opened.
4. Calls `Native.check()`, which runs `background::check()` on a one-off Tokio runtime: per account, unread Inbox mail received since its last check (minus 5 minutes for clock differences), at most 10, not notified before. Gmail: `messages.list` with `in:inbox is:unread after:` and a metadata fetch per message; Graph: `mailFolders/inbox/messages` filtered on `receivedDateTime gt … and isRead eq false`, with an access token from the vault's refresh token (the rotated refresh token isn't kept: the app keeps its own, and earlier ones stay valid). An account seen for the first time only starts counting; one whose check fails tries again from where it was.
5. Shows the notifications it returns: one per message (sender, subject), or one per account for more than three ("5 new messages").

`background.json` holds per account the last check time and up to 200 notified message ids; no content. Accounts that are gone are dropped.

## Phone integration

- **Insets.** `MainActivity` draws edge to edge. The web view reports the status bar as `env(safe-area-inset-top)` but not the navigation bar or the keyboard, so the plugin watches the insets on the web view's parent (not on the web view, whose own listener computes the safe area) and sends what's covered at the bottom as the `insets` event. `android.ts` sets it as `--a0-system-bottom`, and `index.css` defines `--safe-bottom` as the larger of that and `env(safe-area-inset-bottom)`. Every bottom padding and fixed position uses `var(--safe-bottom)`, so the composer's bar sits above the keyboard.
- **Theme.** `AndroidIntegration` watches `data-theme` and the system's dark mode and calls `mobile.setTheme(dark, background)`: the bar icons switch between light and dark and the window background below the page matches it.
- **Back** goes through the web view's history (Tauri's `WryActivity` handles the Back gesture), which is the hash router's; at the start it leaves the app.
- **Incoming intents.** `mailto:` (VIEW, SENDTO) becomes `onCompose`; SEND/SEND_MULTIPLE becomes `onShare` (files copied into `cache/shared/<id>/` on a background thread, then read once with `mobile_read_shared`); `action0://open?account=…&message=…` from a notification becomes `onOpen`, and `AndroidIntegration` opens the message in its account's Inbox. Intents before the UI listens wait in the plugin (`pending`).
- **Files.** Opening, sharing and saving go through the cache and a `FileProvider` (`${applicationId}.fileprovider`), so other apps get a temporary read grant to one file.

## The Platform

`src/platform/native/android.ts` implements `Platform` with `kind: "android"`: `saveFile` (Save to…), `openFileLater` (open with another app), notifications (the permission; `show` does nothing, since the background check notifies and the app itself doesn't, so nothing comes twice), `onCompose`, `onShare`, `onOpen`, and `mobile` (version, package and signature hash for the wizard, `share`, `checkForUpdate` against GitHub's latest release, `setTheme`, `configureBackground`). Shared helpers (`invoke`, link handling, waiting for the first listener, file requests) are in `common.ts`.

In the UI, `AndroidIntegration` (`src/ui/android/`), the Settings section `AndroidSettings`, the attachments' Share button, and the Android texts of the Add account wizard (`googleAndroid`, `microsoftAndroid`) use it.

## Building, running and debugging

- `scripts/android-setup.sh [--emulator]` installs rustup (PATH untouched), JDK 21 and the Android SDK (platform 36, build-tools 36.1.0, NDK r29; with `--emulator` also the emulator, a Google Play system image and an AVD called `action0`) into the home folder. NDK r28 or newer is needed for Google Play's 16 KB pages.
- `scripts/android-env.sh` sets `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME` and PATH for one shell; `scripts/android.sh` runs `tauri android …` with it (`npm run android:dev`, `npm run android:build`). Gradle calls back into `npm run tauri`, so `package.json` has that script.
- Debug builds allow web view debugging: `adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof app.action0.mail)` and open `http://localhost:9333` (or chrome://inspect). `adb logcat | grep -iE "action0|Tauri"` shows the plugin calls.
- Intents can be tried with `adb shell am start`, e.g. a share: `-a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "…" -n app.action0.mail/.MainActivity`.
- CI's `android` job (not required) runs Clippy for `aarch64-linux-android` and builds a debug APK; the release workflow builds the signed APK and AAB (see [releasing.md](releasing.md)). Both use `.github/actions/android-setup`.

## Limits

- No push: the background check runs when Android lets it (about every 15 minutes, less often in Doze), so notifications can be late. Event reminders only remind while the app is open.
- Phones without Google Play services can't add Google accounts.
- Microsoft tenants that require managed devices (Intune, Conditional Access through the broker) refuse the app; that would need MSAL with the broker.
- User-installed certificate authorities aren't trusted (Mozilla's roots only).
- Distributed as an APK on GitHub; from 2027 Google requires verified developers for apps installed outside the Play Store.
