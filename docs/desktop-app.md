# The desktop app

The desktop app is the same React UI as the web app, in a Tauri 2 window, with a small native side in Rust (`src-tauri/`). The native side signs in through the system browser and keeps refresh tokens out of the UI, makes network requests (so CORS doesn't apply), and integrates with the desktop: tray, autostart, `mailto:` links, notifications, the unread badge and updates. This document describes that native side, the IPC between it and the UI, and the `Platform` interface that keeps the rest of the UI unaware of it. User-facing features and the OAuth registrations are in the [README](../README.md#desktop-app); how the two shells fit into the whole in [architecture.md](architecture.md); builds in [building-and-deploying.md](building-and-deploying.md); releases in [releasing.md](releasing.md).

- [Overview](#overview)
- [Rust modules](#rust-modules)
- [IPC commands and events](#ipc-commands-and-events)
- [Capabilities and CSP](#capabilities-and-csp)
- [Native sign-in](#native-sign-in)
- [Vault and keychain](#vault-and-keychain)
- [Networking](#networking)
- [Tray, close to tray and autostart](#tray-close-to-tray-and-autostart)
- [Single instance, mailto and deep links](#single-instance-mailto-and-deep-links)
- [Notifications and the unread badge](#notifications-and-the-unread-badge)
- [Updater](#updater)
- [The Platform interface](#the-platform-interface)

## Overview

```
┌──────────────── web view (dist/) ────────────────┐      ┌──────── native side (Rust) ────────┐
│ React UI ── Platform (src/platform/desktop) ─────┼─IPC─▶│ shell.rs   tray, window, mailto    │
│          ── NativeAuthSession (src/auth/native) ─┼─IPC─▶│ oauth/     sign-in, tokens ── vault│──▶ OS keychain
│ providers ── fetch = nativeFetch ────────────────┼─IPC─▶│ net.rs     HTTP (reqwest)          │──▶ Gmail, Graph, iCal…
└──────────────────────────────────────────────────┘      └────────────────────────────────────┘
```

- `src/main.tsx` detects the app (`"__TAURI_INTERNALS__" in window`) and only then loads `src/platform/desktop` with `import()`, so the web bundle never runs it. `startDesktop()` returns the desktop `Platform`, a native `fetch`, the sign-in bridge and the accounts kept from earlier starts; the composition root (`src/app/services.ts`) passes them to the Gmail and Microsoft modules and to iCal subscriptions.
- The window (`app.windows` in `src-tauri/tauri.conf.json`) is labelled `main`, starts invisible (`visible: false`; the native side shows it unless started hidden), has a minimum size of 360 × 480, uses `https://tauri.localhost` on Windows (`useHttpsScheme`), and leaves file drops to the web view (`dragDropEnabled: false`), so dropping files on the composer works as in the browser.
- `withGlobalTauri` is off: the UI talks to Tauri only through the `@tauri-apps/*` packages, imported in `src/platform/desktop` alone.

## Rust modules

| File                               | What it does                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/main.rs`            | Entry point: calls `action0_lib::run()`. No console window on Windows in release builds.                                                                                                                                                                                                |
| `src-tauri/src/lib.rs`             | Builds the app: installs rustls' `ring` crypto provider (shared by reqwest and the updater), registers the plugins (single instance first), creates the shared HTTP client, the vault and the state, clears the folder for opened files, sets up the shell, and registers the commands. |
| `src-tauri/src/net.rs`             | `net_fetch` / `net_abort`: HTTP requests for the UI with raw bodies, and the shared `reqwest` client.                                                                                                                                                                                   |
| `src-tauri/src/vault.rs`           | Keeps signed-in accounts (refresh tokens included) in an encrypted file, with the key in the OS keychain.                                                                                                                                                                               |
| `src-tauri/src/shell.rs`           | Desktop integration: tray and its menu, hide-to-tray on close, the 5-minute poll tick while hidden, `mailto:` links, the unread badge, the default mail app, opening files with other apps.                                                                                             |
| `src-tauri/src/oauth/mod.rs`       | Sign-in state (`Auth`): browser sign-in, code redemption, access tokens in memory, renewal, sign-out; the `auth_*` commands and the `AuthError` kinds the UI tells apart.                                                                                                               |
| `src-tauri/src/oauth/pkce.rs`      | PKCE (RFC 7636, S256) verifier and challenge, and random `state` values.                                                                                                                                                                                                                |
| `src-tauri/src/oauth/loopback.rs`  | The one-shot HTTP listener on 127.0.0.1 (and ::1) the browser returns to, and the page it shows.                                                                                                                                                                                        |
| `src-tauri/src/oauth/providers.rs` | What differs between Google and Microsoft: endpoints, redirect URIs, authorize URL, token forms, revocation, ID-token claims, scope comparison.                                                                                                                                         |

The modules have unit tests next to the code (`cargo test` in `src-tauri/`; CI runs it with `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`).

## IPC commands and events

Every command registered in `generate_handler!` in `src-tauri/src/lib.rs`:

| Command                  | What it does                                                                                                                   | Called from                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `net_fetch`              | Makes an HTTP request: body as the raw payload, the rest in the `x-a0-request` header; answers `[u32 length][meta JSON][body]` | `createNativeFetch()` in `src/platform/desktop/nativeFetch.ts`                               |
| `net_abort`              | Aborts a request by its id                                                                                                     | `createNativeFetch()` (on the `AbortSignal`)                                                 |
| `auth_accounts`          | The accounts kept from earlier starts, and whether they can be kept at all (`persistent`)                                      | `kept()` in `src/platform/desktop/authBridge.ts`, at startup                                 |
| `auth_connect`           | Signs a new account in through the browser                                                                                     | `connect()` in `authBridge.ts` ← `connectNative()` in `src/auth/native/NativeAuthSession.ts` |
| `auth_sign_in`           | Signs a known account in again (reconnect, more scopes); refuses another account                                               | `signIn()` in `authBridge.ts` ← `NativeAuthSession.signIn()` / `requestScopes()`             |
| `auth_token`             | An access token covering the given scopes (all granted ones if empty), renewed when needed                                     | `token()` in `authBridge.ts` ← `NativeAuthSession.getAccessToken()` / `tokenFor()`           |
| `auth_sign_out`          | Forgets the account and revokes its refresh token where the provider allows it                                                 | `signOut()` in `authBridge.ts` ← `NativeAuthSession.signOut()`                               |
| `shell_configure`        | Sets close-to-tray and the tray menu's texts                                                                                   | `desktop.configure()` in `src/platform/desktop/index.ts`                                     |
| `shell_set_unread`       | Sets the badge count, the Windows taskbar overlay and the tray tooltip/title                                                   | `platform.setUnreadCount()` in `index.ts`                                                    |
| `shell_take_compose`     | Returns `mailto:` links that arrived before the UI was ready and marks it ready                                                | `startDesktop()` in `index.ts`, at startup                                                   |
| `shell_info`             | OS, app version, whether it was started hidden                                                                                 | `startDesktop()`, at startup                                                                 |
| `shell_quit`             | Quits for real                                                                                                                 | `desktop.quit()` in `index.ts` (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Q</kbd>)                   |
| `shell_default_mail_app` | Makes action0 the `mailto:` handler, or opens the place where the user does that                                               | `desktop.makeDefaultMailApp()` in `index.ts`                                                 |
| `shell_open_file`        | Writes a file (raw body, name in `x-a0-name`) to a temporary folder and opens it with the system's app                         | `platform.openFileLater()` in `index.ts` (PDF attachments)                                   |

`auth_*` failures reach the UI as `{ kind, message }` (`AuthError` in `oauth/mod.rs`, serialized with `tag = "kind"`). `toNativeError()` in `authBridge.ts` turns them into a `NativeAuthError`, and `nativeAuthError()` in `NativeAuthSession.ts` into the `MailError` the UI already handles:

| `kind`         | Meaning                                                  | `MailError` kind and reason                                                       |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `reauth`       | The refresh token is gone or refused                     | `auth-required`, `signInAgain`; the session becomes `expired` (the Reconnect bar) |
| `scopes`       | The account hasn't granted the scopes asked for          | `unavailable`, `calendarAccessNeeded`: only that feature is unavailable           |
| `cancelled`    | Another sign-in started, or the 10 minutes ran out       | `auth-required`, `signInClosed`                                                   |
| `denied`       | The user declined, or required scopes weren't granted    | `auth-required`, `accessNotGranted`                                               |
| `wrongAccount` | Signed in with another account than the one reconnecting | `auth-required`, `wrongAccount` (with both addresses)                             |
| `network`      | No answer from the provider                              | `network`, `unreachable`                                                          |
| `provider`     | Any other refusal                                        | `provider`, `signInFailed` (with the provider's text)                             |

Events from the native side to the UI (`shell.rs`), relayed by `relay()` in `index.ts`:

| Event                 | When                                                     | Listener                                                                  |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `a0://poll`           | Every 5 minutes while the window is hidden               | `platform.onPollRequest` ← `useMailSync()` (`src/ui/sync/useMailSync.ts`) |
| `a0://compose`        | A `mailto:` link or the tray's **New mail** (empty link) | `platform.onCompose` ← `DesktopIntegration` → `composeFrom()`             |
| `a0://closed-to-tray` | The window was hidden instead of closed                  | `desktop.onClosedToTray` ← `DesktopIntegration` (one-time notice)         |

Besides these commands the UI uses Tauri's plugins directly from `index.ts`: window (show, unminimize, focus), `plugin-opener` (`openUrl`), `plugin-dialog` (`save`), `plugin-fs` (`writeFile`), `plugin-notification`, `plugin-autostart`, `plugin-updater` (`check`) and `plugin-process` (`relaunch`).

## Capabilities and CSP

`src-tauri/capabilities/main.json` grants the `main` window exactly what the UI calls:

| Permission                                            | For                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:default`                                        | Tauri's core defaults (events, window and app basics)                                                                                                         |
| `core:window:allow-show`, `-set-focus`, `-unminimize` | Bringing the window forward on notification clicks (hiding it into the tray happens on the native side)                                                       |
| `opener:default`                                      | `openUrl` for `http(s):`, `mailto:` and `tel:` (the plugin's default scope, which also allows revealing a file in its folder); no opening of paths            |
| `dialog:allow-save`                                   | The Save dialog for attachments                                                                                                                               |
| `fs:allow-write-file`                                 | Writing the attachment. There's no fs scope, so only paths the user just picked in the Save dialog (which the dialog plugin adds to the scope) can be written |
| `notification:default`                                | Permission, sending, click actions                                                                                                                            |
| `autostart:default`                                   | Enable, disable, query                                                                                                                                        |
| `updater:default`                                     | Check, download, install                                                                                                                                      |
| `process:allow-restart`                               | Relaunch after an update                                                                                                                                      |

The app's own commands (`net_*`, `auth_*`, `shell_*`) need no entry here: `src-tauri/build.rs` defines no app manifest, and Tauri then allows registered commands to the app's own pages (never to remote ones). Opening downloaded files with another app isn't a plugin permission at all: `shell_open_file` writes them on the native side into its own folder and opens that path.

The app's CSP is `app.security.csp` in `src-tauri/tauri.conf.json` (the Vite meta CSP is skipped for desktop builds):

```
default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost;
img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline';
font-src 'self' data:; frame-src 'self' blob:; media-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'none'
```

- `connect-src` allows only Tauri's IPC: the UI's own `fetch` can't reach the network, so every request goes through `net_fetch`.
- `script-src 'self'`: no Google or Microsoft scripts; sign-in is native.
- `img-src https: http:` is there for remote images in mail once the user allows them; the mail iframe's own CSP blocks them until then ([security.md](security.md#html-mail)).
- `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri from adding nonces/hashes to `style-src`; with a nonce present, browsers ignore `'unsafe-inline'`, which mail HTML needs (it's rendered in `srcdoc` frames, which inherit the app's CSP).
- `freezePrototype: true` freezes `Object.prototype` in the web view against prototype pollution.
- `devCsp` is `null`, i.e. not set. Tauri injects the CSP into the bundled `dist/`; under `npm run app:dev` the window loads the Vite dev server instead, so development runs without the app CSP (like `npm run dev` in the browser).

## Native sign-in

Google blocks sign-in inside embedded web views, so the desktop app signs in with the system browser (OAuth authorization code flow with PKCE and a loopback redirect, RFC 8252 style). The flow, in `oauth/mod.rs` `browser_sign_in()`:

1. A new sign-in cancels one still waiting (only one at a time).
2. `Loopback::bind()` listens on `127.0.0.1` at a random free port, and on `::1` at the same port if it can (for browsers that resolve `localhost` to IPv6).
3. A PKCE pair (32 random bytes → 43-character verifier, S256 challenge) and a random `state` are made.
4. The authorize URL opens in the default browser (`tauri-plugin-opener`):

   |                 | Google                                      | Microsoft                                                                           |
   | --------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
   | Authorize       | `accounts.google.com/o/oauth2/v2/auth`      | `login.microsoftonline.com/common/oauth2/v2.0/authorize`                            |
   | Redirect URI    | `http://127.0.0.1:<port>/`                  | `http://localhost:<port>/desktop` (Entra ignores the port)                          |
   | Extra parameter | `access_type=offline` (for a refresh token) | `response_mode=query`                                                               |
   | Client          | "Desktop app" client ID **and secret**      | The same Entra client ID as the web app, "Mobile and desktop applications" platform |

   Both get `response_type=code`, the scopes, `state`, the challenge, `prompt` (`select_account`, or `consent` when asking for more) and `login_hint` for a known account.

5. The loopback server waits up to 10 minutes. It takes only a `GET` to the redirect path that carries a `state`; anything else (a favicon request) gets a 404. It answers with a minimal page, no scripts, `Cache-Control: no-store`, showing one of two texts the UI sent with the request (`PageTexts`): done or failed. The UI picks them from `desktop.signedIn` in `src/i18n/texts/desktop.ts`, in the interface's language (`signedInPage` in `src/main.tsx`), and they're HTML-escaped.
6. `state` must match; `error=access_denied` becomes `denied`, other errors `provider`.
7. The code is redeemed **in Rust** (`code_form()`): with the verifier and redirect URI, plus the client secret for Google and the scopes again for Microsoft. The module docs give the reasons: Microsoft refuses the exchange from a web view, and refresh tokens must never reach the UI.
8. The granted scopes (from the token response, or the requested ones if it doesn't say) must include the request's `required` scopes, or the sign-in fails as `denied`.
9. The address comes from the ID token (`email`, else `preferred_username`; for Microsoft also the tenant `tid`). It's read without checking the signature, because it came straight from the token endpoint over TLS. The account key is `gmail:<address>` or `microsoft:<address>` in lower case, the same id the UI uses.
10. If the provider sent no new refresh token (a repeated sign-in), the stored one is kept. The account goes into the vault, the access token into memory.

**Wrong account.** `auth_sign_in` (reconnecting a known account) compares the key of whoever signed in with the expected one and fails with `wrongAccount` if they differ; nothing about the other account is kept. `auth_connect` (a new account) takes whoever signs in.

**Access tokens.** `auth_token` checks that the account's granted scopes cover the request (else `scopes`), returns the cached token while it has more than 2 minutes left, and otherwise renews it with the refresh token. Renewals run one at a time behind a mutex, because Microsoft hands out a new refresh token with each renewal (which replaces the stored one). `invalid_grant`, `interaction_required` or `consent_required` from the token endpoint mean `reauth`.

**Sign-out.** `auth_sign_out` drops the access token and the vault entry, then revokes the refresh token at `oauth2.googleapis.com/revoke` (best effort). Microsoft has no revocation endpoint for public clients, so its token is only forgotten.

**On the TS side**, `NativeAuthSession` (`src/auth/native/NativeAuthSession.ts`) implements the same `AuthSession` as the web sessions, but with `expiresAt` undefined: renewal is silent, so nothing waits for a click. Concurrent sign-ins share one browser window. The modules build the requests:

| Module                                          | Scopes asked for (`NATIVE_SCOPES`)                                                                                                                                                     | Required                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Gmail (`src/providers/gmail/module.ts`)         | `https://mail.google.com/`, contacts (2), `gmail.settings.basic`, calendar (2), `openid`, `email`: everything at once, as the code notes desktop apps can't add scopes later at Google | `https://mail.google.com/`    |
| Microsoft (`src/providers/microsoft/module.ts`) | `GRAPH_SCOPES`, `Calendars.ReadWrite`, `openid`, `profile`                                                                                                                             | `Mail.ReadWrite`, `Mail.Send` |

Why each scope is needed is in [security.md](security.md#scopes-per-provider). Registering the two clients is in the README ([Signing in from the desktop app](../README.md#signing-in-from-the-desktop-app)).

## Vault and keychain

`src-tauri/src/vault.rs` keeps, per account key: provider, client (ID, and the secret for Google), refresh token, granted scopes, address and Microsoft tenant.

- **Encryption:** XChaCha20-Poly1305 with a 256-bit key and a new random 24-byte nonce on every write. File layout: `A0V1` magic, nonce, ciphertext of the JSON.
- **Key:** 32 random bytes in the OS keychain through the `keyring` crate (Secret Service over D-Bus on Linux, the Keychain on macOS, Credential Manager on Windows), under the service name `app.action0.mail` (the app identifier) and the entry `vault-key`. Only the key goes there, because keychains limit entry sizes (Windows: 2560 bytes) and refresh tokens can be longer.
- **File:** `accounts.vault` in the app's data folder (`app_data_dir()`, named after the identifier: `~/.local/share/app.action0.mail/` on Linux, `~/Library/Application Support/app.action0.mail/` on macOS, `%APPDATA%\app.action0.mail\` on Windows). Writes go to a sibling `.tmp` file that is renamed over it, so a crash never leaves half a file; on Unix the file is `0600`.
- **Unreadable file or other key:** the vault starts empty (the accounts need signing in again).
- **No keychain:** if the keychain can't be read or written, the vault has no key and writes nothing. Accounts work, but only until the app quits; `auth_accounts` reports `persistent: false`, which the platform passes on as `DesktopControls.keychain`. Settings → App then says so (with the Linux hint), and the toast after connecting an account reads "Connected … (until you quit)".

Access tokens are never stored: they live in the `Auth` state's memory and are handed to the UI per request.

## Networking

In the app, every provider request goes through the native side: the Gmail, Microsoft and iCal providers get `desktop.fetch` instead of the browser's `fetch` (`src/main.tsx`, `src/app/services.ts`). That's why iCal addresses load from any server in the app, while the web app depends on CORS headers ([README](../README.md#calendars-by-address-ical)); it's also groundwork for CalDAV.

`createNativeFetch()` (`src/platform/desktop/nativeFetch.ts`) is a drop-in `fetch`:

1. It normalizes the input with `new Request(…)` and reads the body as bytes.
2. It calls `net_fetch` with the body as the **raw** IPC payload and `{id, method, url, headers}` as percent-encoded JSON in the `x-a0-request` header. Raw bytes avoid JSON number arrays, so 25 MB attachments cross the bridge without blowing up (module docs of `net.rs`).
3. The answer is one byte buffer: a 4-byte big-endian length, the response metadata as JSON (status, status text, headers), then the body. `toResponse()` builds a `Response` from it (no body for 101, 103, 204, 205, 304).
4. An `AbortSignal` calls `net_abort` with the request id; the native task is aborted and the promise rejects with an `AbortError`. Failures without an answer reject with a `TypeError`, like `fetch`.

On the Rust side, `parse_meta()` accepts only `http` and `https` URLs (no `file:`), and the shared `reqwest` client (`http_client()`) keeps no cookies, follows redirects only to http(s), has a 30-second connect timeout but none for the body (large uploads take as long as they take), and sends `User-Agent: action0/<Cargo version>`. Sign-in uses the same client.

## Tray, close to tray and autostart

All in `src-tauri/src/shell.rs`:

- **Tray icon** (the window icon) with the tooltip "action0" and a menu: **Show action0**, **New mail** (an empty `a0://compose`) and **Quit**. A left click shows the window where the system reports tray clicks; it doesn't open the menu (`show_menu_on_left_click(false)`). The menu starts in English; `shell_configure` replaces the texts with the interface's (`t.desktop.tray`).
- **Close to tray:** `on_window_event` turns a close request into hiding the window and emits `a0://closed-to-tray`. The UI then shows a notification once ("still running in the tray"; remembered as `a0.settings.trayNoticeShown` in localStorage). Settings → App can switch this off (`closeToTray`, on by default), and closing then quits. **Quit** in the tray and <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Q</kbd> always quit.
- **macOS:** clicking the dock icon of a hidden app shows it again (`RunEvent::Reopen`).
- **Checking mail while hidden:** hidden web views may throttle their own timers, so a native task emits `a0://poll` every 5 minutes while the window is hidden, and `useMailSync()` checks all accounts.
- **Window state:** `tauri-plugin-window-state` restores size, position, maximized and fullscreen state, but not visibility, which stays the native side's call.
- **Autostart** (`tauri-plugin-autostart`, a LaunchAgent on macOS) is off by default and toggled in Settings → App (`src/ui/settings/DesktopSettings.tsx`). The system starts the app with `--hidden` (`HIDDEN_ARG`); `lib.rs` sees the argument and `shell::setup` then leaves the window hidden, so the app starts in the tray.

## Single instance, mailto and deep links

`tauri-plugin-single-instance` is the first plugin registered, so a second start reaches the running app before anything else. With its `deep-link` feature it first hands the second start's arguments to the deep-link plugin; then `on_second_instance` shows the window.

How `mailto:` links arrive differs per system:

| System       | First start                                        | While running                                                          |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Linux, macOS | `deep_link().get_current()`                        | `deep_link().on_open_url` (via the single-instance hand-over on Linux) |
| Windows      | `mailto:` arguments of the process (`mailto_args`) | `mailto:` arguments of the second start, in `on_second_instance`       |

On Windows, `src-tauri/tauri.windows.conf.json` clears the deep-link schemes and the installer registers action0 as a mail client instead ([hooks.nsh](building-and-deploying.md#windows-installer-hooks)), which passes the link as `"%1"`.

**The `ui_ready` flag.** A link can arrive before the UI exists. `compose()` shows the window and then either emits `a0://compose` (UI ready) or queues the link in `pending`. At startup the UI calls `shell_take_compose`, which returns the queue and sets `ui_ready`, so every later link comes as an event. On the TS side `startDesktop()` keeps links (queued ones and events) in `waiting` until the first `onCompose` listener subscribes (`DesktopIntegration`), which hands them to `composeFrom()` in `src/ui/composer/useComposeActions.ts`: a new mail with the link's fields, from the account last sent from (`lastSendAccount`).

**Making action0 the default mail app** (Settings → App, `shell_default_mail_app`):

- Linux: `deep_link().register("mailto")` writes a handler `.desktop` file into the user's applications folder and makes it the `x-scheme-handler/mailto` default with `xdg-mime` (needs `xdg-mime` and `update-desktop-database`). Result `done`.
- Windows: opens `ms-settings:defaultapps`, where the user chooses action0. Result `settings`.
- macOS: the user chooses it in Mail's settings. Result `manual`.

`mailto:` links inside the app and inside mail open a new mail too, through `followLink` (see [below](#the-platform-interface)).

## Notifications and the unread badge

**Notifications** go through `tauri-plugin-notification` (`notifications` in `src/platform/desktop/index.ts`): `supported` is always true and `mustAsk` false (the system decides, no browser prompt); the permission state is read at start and after `request()`. `show()` sends a notification with a numeric id and remembers its click handler (the last 50); `onAction` brings the window forward (`unminimize`, `show`, `setFocus`) and runs the handler. The callers are the same as in the web app: new Inbox mail (`src/ui/sync/notifications.ts`), event reminders (`src/ui/reminders/Reminders.tsx`) and the one-time tray notice.

**The unread count** comes from `useDocumentTitle()` (`src/ui/sync/useDocumentTitle.ts`), which also sets the document title (the tab title in the web app). It calls `platform.setUnreadCount(count, label)`, which skips unchanged values and invokes `shell_set_unread`:

- `window.set_badge_count`: the dock or launcher badge where the system has one (cleared at 0).
- Windows: a taskbar overlay icon, a 32 × 32 PNG the UI draws on a canvas (a red circle with the count, "99+" above 99).
- The tray: the tooltip is the label everywhere; on Linux and macOS the count also shows next to the icon (`set_title`).

## Updater

`tauri-plugin-updater` with the endpoint and public key in `plugins.updater` of `src-tauri/tauri.conf.json`. The UI checks at start and daily, shows a bar and installs only on a click, then relaunches (`plugin-process`). The details, the signing keys and `latest.json` are in [releasing.md](releasing.md#latestjson-and-how-installed-apps-update).

## The Platform interface

Everything that differs between browser and app sits behind one interface, `Platform` in `src/platform/types.ts`:

| Member                 | Web (`src/platform/web.ts`)                                           | Desktop (`src/platform/desktop/index.ts`)                                                              |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `kind`                 | `"web"`                                                               | `"desktop"`                                                                                            |
| `openExternal(url)`    | New tab (`noopener,noreferrer`)                                       | Default browser (`openUrl`)                                                                            |
| `followLink(href)`     | `false`: links open as they do                                        | Same origin: `false`; `http(s):` → default browser; `mailto:` → new mail; anything else isn't followed |
| `saveFile(blob, name)` | Download as `application/octet-stream`                                | Save dialog, then `writeFile`                                                                          |
| `openFileLater()`      | Opens a tab inside the click, fills it with a blob of the forced type | `shell_open_file` (the system's PDF viewer)                                                            |
| `notifications`        | The browser's `Notification` (not on touch devices)                   | `plugin-notification`                                                                                  |
| `setUnreadCount`       | Nothing (the tab title shows it)                                      | `shell_set_unread`                                                                                     |
| `onPollRequest`        | Never fires                                                           | `a0://poll`                                                                                            |
| `onCompose`            | Never fires                                                           | `a0://compose` and links from startup                                                                  |
| `desktop`              | Absent                                                                | `DesktopControls`: version, OS, close-to-tray, autostart, default mail app, updates, quit              |

- `src/platform/context.ts` provides it as a React context (`PlatformContext`, default `webPlatform`); components use `usePlatform()`. `AppProviders` sets the value from the services.
- The desktop platform also registers a capturing `click` listener on the document, so links of the app itself (with `target="_blank"`, which would open nothing in a web view) go through `followLink` too. Links inside mail are handled by the mail frame (`followLinkClick()` in `src/ui/reader/links.ts`).
- `DesktopIntegration` (`src/ui/desktop/DesktopIntegration.tsx`) is the UI's desktop glue: it pushes the close-to-tray setting and tray texts, subscribes to `onCompose`, shows the tray notice, registers <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Q</kbd> and renders the update bar. It renders nothing in the web app.
- ESLint enforces the boundary (`no-restricted-imports` in `eslint.config.js`): `@tauri-apps/*` is forbidden in `src/` outside `src/platform/desktop/`. Two exceptions in the config: tests may import anything, and `src/core` has its own import rule, which doesn't list Tauri. Tests use a fake desktop platform (`src/test/desktopPlatform.ts`) instead of Tauri ([testing.md](testing.md)).
