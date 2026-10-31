# Security

action0 holds access to whole mailboxes and calendars, and it renders HTML written by strangers. This document describes what it protects against and how: where tokens live, what is stored on the device, how HTML mail is contained, the app's Content Security Policy, which OAuth scopes it asks for and why, and what the desktop app adds. The user-facing summary is in the README ([What is stored where](../README.md#what-is-stored-where), [Security model for HTML mail](../README.md#security-model-for-html-mail)); the desktop app's internals are in [desktop-app.md](desktop-app.md), and the reasoning behind the bigger choices in [decisions.md](decisions.md).

- [Threat model and goals](#threat-model-and-goals)
- [Tokens and where they live](#tokens-and-where-they-live)
- [What is stored where](#what-is-stored-where)
- [HTML mail](#html-mail)
- [App CSP](#app-csp)
- [Scopes per provider](#scopes-per-provider)
- [Desktop specifics](#desktop-specifics)
- [Reporting issues](#reporting-issues)

## Threat model and goals

**No backend.** The web app is static files; the desktop app is the same files plus a native side on the user's machine. There's no action0 server, no analytics and no telemetry. Mail, contacts and calendars travel only between the device and the provider (Gmail, Microsoft Graph, Google People and Calendar), plus four kinds of requests the user causes: remote images in a mail once allowed, a one-click unsubscribe POST to the sender's server, iCal subscriptions the user added, and requests to the AI service the user set up, only when they press an AI button ([AI keys](#ai-keys)).

What the design guards against:

| Threat                                                                    | Main defences                                                                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious HTML mail (script, phishing forms, tracking pixels, CSS tricks) | DOMPurify, a sandboxed iframe without scripts, a CSP inside the frame that blocks all remote loads until the user allows images ([HTML mail](#html-mail))                              |
| Script injection into the app                                             | The app CSP (`script-src` limited to the app and Google's sign-in script, so no inline scripts and no `eval`), the mail frame's isolation                                              |
| Token theft from storage                                                  | No tokens in localStorage; web tokens in sessionStorage (per tab, gone when it closes); desktop refresh tokens only in the native vault, encrypted, key in the OS keychain             |
| Long-lived copies of mail on the device                                   | Message bodies aren't persisted; list caches in sessionStorage have a 10-minute maximum age and go with the tab; PDFs opened by the desktop app go to a folder emptied at every start  |
| Over-broad access                                                         | Optional scopes can be declined, calendar access is separate; the desktop UI only ever gets short-lived access tokens                                                                  |
| Mail that tries to instruct the AI assistant                              | Mail goes to the AI only on a click, as text without hidden elements, marked as data; the AI can't act, and its answer is shown and inserted as text, never HTML ([AI keys](#ai-keys)) |
| Supply chain                                                              | Locked dependencies, no third-party scripts at runtime except Google's sign-in client in the web app, signed desktop updates                                                           |

Supply chain in more detail: `package-lock.json` (installed with `npm ci`) and `src-tauri/Cargo.lock` (CI's clippy and tests run with `--locked`) pin every dependency; several runtime packages are pinned to exact versions in `package.json` (MSAL, the Tauri packages, Tiptap, `ical.js`). MSAL is bundled and loaded from the app's own origin. The only remote script is `https://accounts.google.com/gsi/client` in the web app (`src/auth/google/gis.ts`). Desktop updates are signed and verified before installing ([releasing.md](releasing.md#updater-signing-keys-and-secrets)). GitHub Actions are referenced by version tag (`actions/checkout@v7`, `tauri-apps/tauri-action@v1`, …).

Out of scope: a compromised device or browser, a malicious browser extension, and the providers themselves.

## Tokens and where they live

The rule from `CLAUDE.md`: tokens live in memory or sessionStorage, **never** in localStorage; in the desktop app, refresh tokens live only on the native side.

**Web app, Google** (`src/auth/google/`): Google Identity Services' token model gives the browser an access token (one hour) and no refresh token. `sessionTokenStore()` (`tokenStore.ts`) keeps it in sessionStorage under `a0.token.<accountId>` as `{accessToken, expiresAt, scope, requested}`, so a reload doesn't need a new popup; the `TokenStore` interface is documented as never backed by localStorage. Within 5 minutes of expiry the next click or key press renews it (`src/auth/refreshOnInteraction.ts`, installed in `src/app/AppProviders.tsx`; only a user gesture may open the popup). Touch devices skip this, because the popup would open as a new tab. An expired token shows the Reconnect bar instead.

**Web app, Microsoft** (`src/auth/microsoft/msal.ts`): MSAL runs with `cacheLocation: "sessionStorage"`, so its whole token cache stays in the tab's sessionStorage. `a0.microsoft.account.<accountId>` (sessionStorage) remembers which MSAL account belongs to an action0 account. MSAL renews tokens by itself for about 24 hours, and longer while the browser is signed in to Microsoft and allows MSAL's hidden renewal frame (which returns to `redirect.html`); then the Reconnect bar asks for a click ([README](../README.md#setting-up-microsoft-sign-in)).

**Desktop app** (`src-tauri/src/oauth/`, `src-tauri/src/vault.rs`): the native side signs in, redeems the code and keeps the refresh token in the vault. Access tokens stay in the native side's memory and are handed to the UI per request through `auth_token`; `NativeAuthSession` (`src/auth/native/NativeAuthSession.ts`) doesn't store them, and the Gmail module gets no token storage in the app (`tokenStorage: undefined` in `src/app/services.ts`). The UI never sees a refresh token. Details in [desktop-app.md](desktop-app.md#native-sign-in).

Signing out forgets the account's tokens. On the web, the Google session clears its sessionStorage entry and revokes the access token (`oauth2.revoke`), and the Microsoft session removes the account from MSAL's cache (the browser itself stays signed in to Microsoft). In the desktop app, `auth_sign_out` deletes the vault entry and revokes Google's refresh token.

Client IDs aren't secrets: they're compiled in (`VITE_*`) or stored as settings. The Google desktop client's secret is handled the same way: Google treats secrets of desktop clients as not confidential, and when it's built in, anyone can read it from the app.

## AI keys

The AI assistant ([ai.md](ai.md)) uses the user's own AI service, so its keys are the user's, and they cost money when used.

- **Web app:** an API key (or the key OpenRouter's sign-in hands out) is kept in sessionStorage under `a0.ai.key.<service id>`, so it's gone when the browser closes. Only when the user ticks **Remember in this browser** for that service does it go to localStorage instead: the one opt-in exception to keeping secrets out of localStorage, decided because pasting a key every session is a real burden; the checkbox says that anyone using the browser profile could use the key. Requests carry the key only to the service's own address (`webBackend.ts` refuses others), with `credentials: "omit"` and `referrerPolicy: "no-referrer"`. Sign in with ChatGPT isn't offered: OpenAI documents it for apps only, and its rules keep its tokens out of browser storage.
- **Apps:** keys and ChatGPT sign-ins live only in the native side's `ai.vault` (encrypted like the accounts' vault, with the same key) and never reach the web view. `ai_request` adds them to a request only if its URL, parsed, is the service's address or below it, and drops any key header the UI set; ChatGPT's access tokens go only to `https://api.openai.com/v1` ([desktop-app.md](desktop-app.md#ai-assistant)).
- **What is sent.** Nothing until the user presses an AI button; before a service's first use a note says what it gets and links its data policy. The AI gets the mail as text: headers that matter and the text, never attachments or images, and without elements the sender hid (`display:none`, zero-size text and similar), which is where text meant to steer a machine usually hides. Gemini's free tier may use what it's sent for training; Settings says so.
- **Mail that tries to instruct the AI.** A mail can contain text like "ignore your instructions and…". The mail goes to the AI between markers it's told to treat as data, but that's a mitigation, not a guarantee. What limits the damage is that the AI can't do anything: it has no tools or actions, its answer is shown as React elements (paragraphs, lists, bold) and inserted into the composer as editor nodes, never parsed as HTML, and nothing it writes is sent without the user.
- **Answers** stay in memory (the panel's state in the UI store), never in browser storage.

## Mail server accounts

IMAP/SMTP accounts ([imap.md](imap.md)) exist only in the apps, where the native side talks to the servers.

- **Passwords and sign-ins** (an IMAP password or a Yahoo/AOL refresh token) go from the wizard straight to the native side and are kept only in `imap.vault`, encrypted with the vault key; the UI never reads them back. Without a keychain they last until the app quits, like the other accounts.
- **Encryption is required**: TLS from the start or STARTTLS that has to succeed; capabilities seen before STARTTLS are thrown away (they could be injected); a login never goes out in plain text.
- **Calendar servers (CalDAV)** use the mail account's login or their own, kept in `caldav.vault`. `caldav_request` adds the login only for the server's own hosts (found while setting it up, including a provider's separate contacts host), replaces any `Authorization` the UI set, and follows redirects itself only within those hosts and never from https to http ([caldav.md](caldav.md#the-native-side)). A certificate the system doesn't trust is handled like IMAP's.
- **Certificates.** The system's trust store decides. A certificate it refuses can be trusted only while adding the account, after the user saw its fingerprint, names, issuer and dates, and only for that account (RFC 8314); its SHA-256 is kept in the vault, accepted besides the system's, and can be forgotten in the Accounts panel. A different untrusted certificate later is refused, with no way to click through.
- **Looking up settings** sends the address's domain (never the address or password) to the provider's own autoconfig host and to Mozilla's ISPDB (`autoconfig.thunderbird.net`), and asks DNS for its MX records (desktop).
- **No mail on disk**: lists, messages and attachments are fetched when needed and cached in memory only.
- **SMTP** gets the message without its Bcc header; the copy kept in Sent has it, as other clients do. Addresses that would inject SMTP commands are refused.

## What is stored where

The README has the summary table. In detail, by key:

**localStorage** (kept across sessions):

| Key                                                                                              | Content                                                                                                                                      | Source                                                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `a0.accounts`                                                                                    | Account list: id, provider type, address. No credentials                                                                                     | `src/accounts/accountStorage.ts`                                            |
| `a0.ui`                                                                                          | The persisted part of the UI store (`partialize`): column widths, expanded tree nodes, list order, settings, reminder marks, account colours | `src/state/uiStore.ts`                                                      |
| `a0.theme`                                                                                       | `light` or `dark` (absent: follow the system)                                                                                                | `src/state/theme.ts`, read by `public/theme.js`                             |
| `a0.settings.googleClientId`, `a0.settings.googleDesktopClient`, `a0.settings.microsoftClientId` | OAuth client IDs entered in the wizard (the desktop Google client with its secret)                                                           | `src/app/googleSetup.ts`, `src/app/microsoftSetup.ts`                       |
| `a0.settings.signatures.<accountId>`                                                             | Signatures of Microsoft and IMAP accounts (Graph and IMAP servers can't store them)                                                          | `src/providers/senderStore.ts`                                              |
| `a0.settings.senders.<accountId>`                                                                | Their further From addresses (name, Reply-To, Bcc to myself, default) and catch-all domains                                                  | `src/providers/senderStore.ts`                                              |
| `a0.settings.notificationsAsked`, `a0.settings.trayNoticeShown`                                  | One-time flags                                                                                                                               | `src/ui/sync/NotificationsBar.tsx`, `src/ui/desktop/DesktopIntegration.tsx` |
| `a0.ai.key.<serviceId>`                                                                          | An AI service's key, only if the user ticked **Remember in this browser** for it ([AI keys](#ai-keys))                                       | `src/ai/webBackend.ts`                                                      |

The settings inside `a0.ui` (`AppSettings` in `src/state/settings.ts`) include two things worth knowing: the **trusted senders** for remote images (addresses the user chose, at most 500, oldest dropped first) and the **iCal subscriptions**, whose URLs can be secret (whoever has one can read the calendar). Reminder marks are snooze/dismiss times by reminder key, no content, dropped once the event is over (`liveMarks()` in `src/core/reminders.ts`). The AI services set up are kept there too (kind, address, name; never their keys). Nothing in `a0.ui` contains mail.

**sessionStorage** (per tab, gone when it closes):

| Key                                | Content                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `a0.token.<accountId>`             | Google access token, expiry, granted and requested scopes (web app) |
| MSAL's own keys                    | MSAL's token cache (web app)                                        |
| `a0.microsoft.account.<accountId>` | The MSAL account id                                                 |
| `a0.query-cache`                   | The persisted query cache                                           |
| `a0.ai.key.<serviceId>`            | An AI service's key, unless it's remembered in localStorage         |

The query cache (`src/data/queryClient.ts`) persists only queries marked `meta: { persist: true }` that succeeded: mailbox lists, message and conversation list pages (not search results), calendar lists and events (`src/data/hooks.ts`, `src/data/calendar.ts`). List pages hold message summaries (sender, recipients, subject, a short snippet, date, flags), not bodies. Restored entries older than `PERSIST_MAX_AGE_MS` (10 minutes) are discarded, and so is everything when the app version (the `buster`) changes; writes are throttled to one per second, and when storage is full the oldest query is dropped (`removeOldestQuery`). Complete messages and conversations are memory only.

**Memory only:** message bodies, inline images, attachments, a message's original while "Show original" shows it (its query has no `persist` and is dropped when the view closes), the mail being written (it saves to the provider's Drafts, never to browser storage), which messages may load remote images in this session (`remoteContentAllowed`), search results, contact suggestions, the event editor's values, the AI assistant's answers and the models services offer.

**Desktop app, on disk:** the encrypted vaults (`accounts.vault`, `imap.vault` for IMAP accounts' settings and passwords or Yahoo/AOL refresh tokens, `caldav.vault` for calendar servers' addresses and separate logins, and `ai.vault` for the AI assistant's keys and sign-ins), PDFs opened with another app (emptied at every start), the window-state plugin's window geometry, and the web view's own localStorage and sessionStorage with the keys above. See [Desktop specifics](#desktop-specifics).

## HTML mail

HTML mail goes through three independent layers.

### 1. Sanitizing (`src/security/sanitize.ts`)

`sanitizeMailHtml()` runs DOMPurify with:

- `WHOLE_DOCUMENT: true` (mail is a full document, `<style>` in `<head>` included);
- `FORBID_TAGS`: `script`, `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `portal`, `form`, `input`, `button`, `textarea`, `select`, `option`, `link`, `meta`, `base`, `noscript`;
- `FORBID_ATTR`: `srcdoc`, `formaction`, `ping`, `action`;
- `ADD_ATTR: ["target"]`, `ALLOW_DATA_ATTR: false`.

DOMPurify itself removes event handlers and `javascript:` URLs. Two hooks add to that: one detects remote content (`src`, `background`, `poster`, `data`, `srcset`, `href` on SVG `image`/`use`, and `url(…)` or `@import` in `<style>` and `style` attributes) and sets `hasRemoteContent`; the other gives every `<a href>` `target="_blank"` and `rel="noopener noreferrer"`.

The same sanitizer runs wherever HTML from outside is shown: the reader (`src/ui/reader/MessageBody.tsx`), event descriptions (`src/ui/calendar/EventDetails.tsx`, remote images always off), quoted originals in replies and forwards (`src/compose/quote.ts`) and the signature preview in the composer (`src/ui/composer/Composer.tsx`, the user's own signature, with remote images on).

### 2. The mail document and its CSP (`src/security/mailDocument.ts`)

`buildMailDocument()` parses the sanitized HTML with `DOMParser` (an inert document: nothing loads or runs), replaces `cid:` images with the `data:` URLs of the inline parts (an unresolved one loses its `src`, so nothing is requested), and puts four elements first in `<head>`: the CSP, a viewport, `<meta name="referrer" content="no-referrer">` and a small base stylesheet (light colour scheme). The CSP:

```
default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:
```

`default-src 'none'` blocks every fetch: images, fonts, CSS imports, media, prefetch. When remote images are allowed, `img-src` gains `https: http:`; nothing else is ever unblocked.

### 3. The sandboxed iframe (`src/ui/reader/SafeHtmlFrame.tsx`)

The document goes into an `<iframe srcdoc>` with:

```
sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
referrerpolicy="no-referrer"
```

- **No `allow-scripts`**, ever. Together with `allow-same-origin` it would give mail content full access to the app (the source says so next to `MAIL_FRAME_SANDBOX`).
- `allow-same-origin` (harmless without scripts) lets the app measure the content to size the frame, zoom wide mails, and listen for key presses and clicks from outside, so shortcuts keep working inside a mail.
- `allow-popups` and `allow-popups-to-escape-sandbox` let links open in a normal new tab.
- No forms can be submitted (no `allow-forms`, and form elements are removed anyway).
- A `srcdoc` frame also inherits the app's own CSP ([App CSP](#app-csp)).

### Remote content consent

`MessageBody` loads remote images when either the user clicked **Load images** for this message (kept in memory, in `remoteContentAllowed`), or the setting allows it (`loadsRemoteImages()` in `src/state/settings.ts`):

| Setting `remoteImages` | Behaviour                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `ask` (default)        | Blocked; a bar offers **Load images** when the mail has remote content                            |
| `always`               | Loaded                                                                                            |
| `trusted`              | Loaded for senders in `trustedSenders`; otherwise the bar also offers **Always from this sender** |

Blocking remote images by default also blocks read-tracking pixels.

### Links

The sanitizer makes every link open in a new tab without opener or referrer. On click, `followLinkClick()` (`src/ui/reader/links.ts`) asks the platform first: the web app lets the link open as it does; the desktop app opens `http(s):` in the default browser, `mailto:` in a new mail, and follows nothing else (`followLink` in `src/platform/native/desktop.ts`).

### Attachments

Attachments are never rendered as pages in the app's origin (`attachmentKind()` in `src/ui/common/files.ts`):

- Images (PNG, JPEG, GIF, WebP, AVIF, BMP, SVG) open in the in-app viewer as `<img>`, where SVG can't run scripts.
- PDFs open in a new tab from a blob whose type is forced to `application/pdf`, with the opener cut (`openFileLater` in `src/platform/web.ts`); the desktop app opens them with the system's viewer.
- Everything else (HTML, XML, …) is only downloaded, as `application/octet-stream`, so the browser never renders it (`downloadBlob()` in `src/platform/web.ts`).

### Show original

A message's source is untrusted text. The view (`src/ui/original/`) only ever renders it as text nodes (React escapes it), never as HTML. The summary's SPF, DKIM and DMARC badges come only from the topmost `Authentication-Results` header, which the account's own provider added on arrival; lower ones may have been written by anyone, sender included (`authResults` in `src/core/rawMessage.ts`). None of it changes what the app trusts (remote images, links): it's information for the user.

## The installable web app

The web app's service worker (`src/sw/serviceWorker.ts`, built as `/sw.js`; production web builds only, never in the Tauri apps) keeps only the app's own files, listed at build time: `index.html`, the hashed `assets/`, `theme.js`, the icons and the manifest, in a cache named after their version (older ones are deleted). Every other request goes to the network untouched: the provider and AI APIs, sign-in, `redirect.html`, other sites. Mail and API answers are never stored, so installing the app changes nothing about what's kept ([what is stored where](#what-is-stored-where)).

Content shared to the installed app ("Share → action0" on Android) arrives as a `POST /share-target`; the worker holds it in its memory only until the page takes it (once, by a random id in the address) and starts a new mail with it. Notifications shown through the worker carry only the title, the text and the page address of the message (`data: {tag, url}`); a click focuses the app or opens it at that address.

## App CSP

Production builds of the web app carry this policy as a `<meta>` tag, injected by the `action0:csp` plugin in `vite.config.ts` (the dev server runs without it, because hot reload needs inline scripts):

| Directive      | Value                                                                       | Why                                                                                                                 |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `default-src`  | `'self'`                                                                    | Everything else only from the app's origin                                                                          |
| `script-src`   | `'self' https://accounts.google.com/gsi/client`                             | The app, and Google's sign-in script. No inline scripts (the theme script is a file, `public/theme.js`)             |
| `style-src`    | `'self' 'unsafe-inline' https://accounts.google.com/gsi/style`              | Mail HTML is rendered in `srcdoc` frames, which inherit this policy and need inline styles; Google's sign-in styles |
| `connect-src`  | `'self' https: http://localhost:* http://127.0.0.1:*`                       | The provider APIs, iCal subscriptions, AI services, one-click unsubscribe (below), and local AI servers             |
| `frame-src`    | `'self' https://accounts.google.com/gsi/ https://login.microsoftonline.com` | Google's sign-in frame; MSAL's hidden renewal frame, which returns to `redirect.html` (`'self'`)                    |
| `img-src`      | `'self' data: blob: https: http:`                                           | Remote images in mail once allowed (the mail frame's own CSP blocks them until then); inline and viewer images      |
| `font-src`     | `'self' data:`                                                              |                                                                                                                     |
| `object-src`   | `'none'`                                                                    | No plugins                                                                                                          |
| `worker-src`   | `'self'`                                                                    | The installable web app's service worker (`/sw.js`)                                                                 |
| `manifest-src` | `'self'`                                                                    | Its manifest                                                                                                        |
| `base-uri`     | `'none'`                                                                    | No `<base>` hijacking                                                                                               |
| `form-action`  | `'none'`                                                                    | No form submissions                                                                                                 |

**Why `connect-src https:`.** One-click unsubscribe (RFC 8058) sends a POST to the sender's server, which can be any host. `sendOneClickUnsubscribe()` (`src/providers/oneClickUnsubscribe.ts`) only accepts `https:` URLs and sends `List-Unsubscribe=One-Click` with `mode: "no-cors"`, `credentials: "omit"` and `referrerPolicy: "no-referrer"`; the answer is opaque, so the app can't read it. The decision (see `CLAUDE.md`) notes that remote images may already load from anywhere once allowed, so this barely widens what the app can reach. `http://localhost` and `127.0.0.1` are there for the AI assistant's local servers (Ollama, LM Studio), which run on the user's own computer.

A `<meta>` CSP can't set `frame-ancestors`; hosts that can send headers may add it ([building-and-deploying.md](building-and-deploying.md#hosting-the-static-app)). The desktop app has its own, stricter CSP in `src-tauri/tauri.conf.json`: no remote scripts, and `connect-src` allows only Tauri's IPC, so the web view can't make requests of its own ([desktop-app.md](desktop-app.md#capabilities-and-csp)).

## Scopes per provider

### Google

Defined in `src/providers/gmail/module.ts` and `src/providers/gmail/calendar.ts`:

| Scope                                                                                 | Kind      | Why                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://mail.google.com/` (`GMAIL_SCOPE`)                                            | Required  | Full mailbox access. Needed for permanent deletion ("Delete forever", "Empty Trash"); everything else would work with `gmail.modify`. Tokens with a narrower scope count as expired and ask for a reconnect |
| `…/auth/contacts.readonly`, `…/auth/contacts.other.readonly` (`CONTACTS_SCOPES`)      | Optional  | Address suggestions from contacts and "other contacts" (People API)                                                                                                                                         |
| `…/auth/gmail.settings.basic` (`SETTINGS_SCOPE`)                                      | Optional  | Editing signatures; declined, they're read-only and Settings offers **Allow editing**                                                                                                                       |
| `…/auth/calendar.calendarlist.readonly`, `…/auth/calendar.events` (`CALENDAR_SCOPES`) | On demand | Listing calendars; reading events, answering invitations, creating and editing events                                                                                                                       |
| `openid`, `email`                                                                     | Desktop   | The ID token tells the native side who signed in                                                                                                                                                            |

Web app: connecting asks for the mail, optional and calendar scopes at once with only `GMAIL_SCOPE` required, so the user can untick the rest in Google's dialog. Later renewals (`GoogleAuthSession`) don't ask again for optional scopes the user declined, and calendar access can be added with **Allow calendar**. Desktop app: everything is asked for at every sign-in (`NATIVE_SCOPES`), with the same single required scope. `https://mail.google.com/` is a restricted scope, with consequences for publishing the Google app ([README](../README.md#setting-up-google-sign-in)).

### Microsoft

Defined in `src/auth/microsoft/msal.ts`:

| Scope                                     | When              | Why                                                                                                                    |
| ----------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Mail.ReadWrite`                          | Sign-in           | Reading, moving, flagging and deleting mail; drafts                                                                    |
| `Mail.Send`                               | Sign-in           | Sending                                                                                                                |
| `People.Read`                             | Sign-in           | Address suggestions                                                                                                    |
| `User.Read`                               | Sign-in           | The signed-in user's basic profile (already there in a new registration)                                               |
| `MailboxSettings.ReadWrite`               | Sign-in           | Outlook's category list (`me/outlook/masterCategories`): categories as labels, creating, recolouring and deleting them |
| `offline_access`                          | Sign-in           | Refresh tokens (MSAL's silent renewal; the desktop vault)                                                              |
| `Calendars.ReadWrite` (`CALENDAR_SCOPES`) | Sign-in, or later | The calendar: consented to when connecting (`extraScopesToConsent`), or later with **Allow calendar**                  |
| `openid`, `profile`                       | Sign-in           | Added by MSAL on the web; requested explicitly by the desktop app                                                      |

`GRAPH_SCOPES` are the first six. The desktop app requires `Mail.ReadWrite` and `Mail.Send` and fails a sign-in without them (`src/providers/microsoft/module.ts`). Adding a scope (as `MailboxSettings.ReadWrite` was for categories) makes existing accounts reconnect once.

## Desktop specifics

- **Vault.** Refresh tokens are encrypted with XChaCha20-Poly1305; the 256-bit key is in the OS keychain (`app.action0.mail` / `vault-key`), the file in the app's data folder with mode `0600` on Unix. Without a keychain nothing is written and accounts last until the app quits ([desktop-app.md](desktop-app.md#vault-and-keychain)).
- **Sign-in.** The loopback listener binds only to `127.0.0.1` and `::1`, on a random port, for one callback, for at most 10 minutes; `state` and PKCE (S256) tie the answer to the request; the page it shows has no scripts. Reconnecting refuses a different account.
- **Network.** The web view's CSP allows no network connections (`connect-src ipc: http://ipc.localhost`); requests go through `net_fetch`, which accepts only `http` and `https` URLs and keeps no cookies. Because `net_fetch` makes any such request without CORS, script injection into the web view would be worth more than in a browser tab, which is why the layers above (`script-src 'self'`, the sanitizer, the sandbox) and Tauri's `freezePrototype` matter.
- **Capabilities** (`src-tauri/capabilities/desktop.json`) apply to the `main` window only and list just the plugin calls the UI makes ([desktop-app.md](desktop-app.md#capabilities-and-csp)). Tauri allows the app's own commands only to the app's local pages.
- **Opening links and files.** `opener:default` limits `openUrl` to `http(s):`, `mailto:` and `tel:`, and `followLink` itself refuses every other scheme (`file:`, `javascript:`, other apps). The UI can't open file paths at all: `shell_open_file` writes the file on the native side into `<app cache folder>/open/<random>/` under a cleaned name (`safe_name()`: path separators, reserved and control characters replaced, leading and trailing dots trimmed) and opens only that path. Only PDF attachments use it.
- **Temporary folder.** `<app cache folder>/open` is deleted at every start (`files::clear()` in `src-tauri/src/files.rs`), so opened attachments don't pile up on disk.
- **Saving.** Attachments are written only to the path the user picked in the Save dialog; the fs plugin has no other scope.
- **Updates** are verified against the public key compiled into the app before installing, and only newer versions are accepted ([releasing.md](releasing.md#latestjson-and-how-installed-apps-update)).
- **`mailto:` links from other apps** only open a filled-in new mail; nothing is sent without the user.

## Android specifics

The Android app shares the desktop app's native side; what differs ([android.md](android.md)):

- **Google accounts** get access tokens from Google Play services, which identifies the app by its package and signing certificate. No Google refresh token exists on the phone; the vault keeps only the account's address and scopes.
- **Microsoft accounts** sign in in a Custom Tab (the browser, not a web view) with PKCE and `state`; the answer comes back through the `msauth://app.action0.mail/<signature hash>` link. Another app could register the same scheme, but without the PKCE verifier a caught code is useless. The refresh token is kept in the vault as on the desktop.
- **Vault key.** The vault's key is encrypted with an AES-256-GCM key generated in the Android Keystore (`action0-vault`), which never leaves it, and stored in the app's private preferences. App data isn't readable by other apps.
- **Background check.** `background.json` (app data) holds whether it's on, the notification texts, and per account the last check time and notified message ids; no content. Notifications show sender and subject, like the desktop's.
- **Files for other apps** go through a `FileProvider` that only exposes the app's cache (`res/xml/file_paths.xml`), with a read grant for one file per intent. Shared files from other apps are copied into `cache/shared/` and handed to the UI once (`mobile_read_shared` accepts only paths inside that folder), then deleted.
- **Incoming links.** Only `mailto:`, shares and `msauth://` answers are accepted from other apps; notification taps use an explicit intent to the app's own activity, so other apps can't send `action0://` links to it.
- **Network.** The same `net_fetch`; TLS trusts Mozilla's root certificates compiled into the app, not user-installed CAs.
- **Capabilities** (`src-tauri/capabilities/android.json`): the web view may only call `opener` and two commands of action0's plugin (`pending`, `insets`); everything else goes through the app's own commands.

## Reporting issues

Please report security problems privately: on the GitHub repository ([LaughInJar/action0-mail-client](https://github.com/LaughInJar/action0-mail-client)), open **Security → Report a vulnerability** to create a private security advisory, instead of a public issue.

In any issue, don't post access or refresh tokens, client secrets, iCal addresses, mail content or the contents of `.env.local`; redact them from screenshots and logs too.
