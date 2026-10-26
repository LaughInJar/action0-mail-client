# Design decisions

Why action0 is built the way it is. Each entry gives the context, the decision, the reasons and what it costs. The authoritative, complete list of approved decisions (including small UX choices) is the decisions log in [`CLAUDE.md`](../CLAUDE.md#decisions-log); this document explains the big ones so they can be revisited with their reasons in view.

- [A static app without a backend](#a-static-app-without-a-backend)
- [TanStack Query for server state, Zustand for UI state](#tanstack-query-for-server-state-zustand-for-ui-state)
- [One mailbox model for labels and folders](#one-mailbox-model-for-labels-and-folders)
- [Writes are intents, applied optimistically, with undo](#writes-are-intents-applied-optimistically-with-undo)
- [Navigation in the URL hash](#navigation-in-the-url-hash)
- [Tokens: short-lived, never in localStorage](#tokens-short-lived-never-in-localstorage)
- [HTML mail in a sandbox, remote content blocked](#html-mail-in-a-sandbox-remote-content-blocked)
- [Messages by default, conversations as an option](#messages-by-default-conversations-as-an-option)
- [Translations without a library](#translations-without-a-library)
- [A desktop app with Tauri, and no proxy](#a-desktop-app-with-tauri-and-no-proxy)
- [All inboxes: per-account lists, merged; a context account](#all-inboxes-per-account-lists-merged-a-context-account)
- [What can be edited is described per mailbox kind](#what-can-be-edited-is-described-per-mailbox-kind)
- [A fixed way of working](#a-fixed-way-of-working)

## A static app without a backend

**Context.** The project exists because the Gmail web interface is a poor experience; the goal is a better client, not a mail service.

**Decision.** action0 is a set of static files. It signs in with OAuth in the browser and calls the providers' REST APIs (Gmail, Microsoft Graph, Google Calendar) directly. There is no action0 server.

**Why.** Nothing to operate, nothing to breach: mail goes from the provider to the user's device and nowhere else. Anyone can host it (or run it locally), and it costs nothing to run.

**Trade-offs.** Everything a server would normally do happens in the browser: caching, sync (polling with the providers' change APIs), search (the providers' own), sending. Protocols a browser can't speak (IMAP, SMTP, CalDAV without CORS) are out of reach for the web app; the desktop app covers them (below). Browser sessions for Google can't refresh silently forever, so web users see a Reconnect bar from time to time.

## TanStack Query for server state, Zustand for UI state

**Context.** A mail client is mostly a cache of server state that must stay fresh, survive a reload, update optimistically and roll back.

**Decision.** TanStack Query holds everything that comes from a provider (lists, messages, mailboxes, calendars), with short-lived sessionStorage persistence for lists. Zustand holds what's on screen (focus, selection, dialogs, composer, settings). Providers do no caching at all.

**Why.** TanStack Query already solves cache keys, staleness, revalidation, infinite lists, cancellation, persistence and mutation lifecycles, which made optimistic updates with rollback straightforward. Keeping caching out of the providers keeps them simple, stateless translators that are easy to test against mocked HTTP. Zustand is small, works outside React (the keyboard layer and actions read it imperatively) and needs no providers.

**Trade-offs.** Two state systems to learn. Some features need care at the seam, for example the merged All inboxes list observes several infinite queries with a custom hook, because TanStack has no `useQueries` for infinite queries.

## One mailbox model for labels and folders

**Context.** Gmail has labels (a message can have many), Exchange and IMAP have folders (one per message), and every provider has special mailboxes (Inbox, Sent, Trash).

**Decision.** The model follows JMAP (RFC 8621): a message has a _set_ of mailbox IDs; each mailbox has a kind (`label`, `folder`, or the computed `view`), an optional role and a parent. Read and starred are flags, not mailboxes. See [domain-model.md](domain-model.md).

**Why.** One model fits Gmail, Outlook and IMAP without provider branches in the UI. Outlook categories later fitted in as labels next to folders without changing the model.

**Trade-offs.** Some provider behaviour has to be expressed through roles and capabilities (archiving means "leave the Inbox" for Gmail but "move to Archive" for Outlook), and the optimistic prediction (`planChanges`) has to know the difference between exclusive folders and labels.

## Writes are intents, applied optimistically, with undo

**Context.** The UX goal is instant reactions and the freedom to undo anything.

**Decision.** Every change to mail is an intent, plain data like `{ kind: "archive", ids }`. The data layer predicts its effect from the cache, applies it at once, sends it to the provider, rolls back on failure and offers Undo, built from what actually changed (`inverseOf`). What can't be undone (deleting forever, unsubscribing) asks first instead.

**Why.** Plain data can be predicted, tested without a provider, grouped (one action across several accounts) and inverted exactly ("undo never removes a label the message already had"). Each provider just translates intents into its API calls.

**Trade-offs.** The prediction has to match what the provider will do; when it can't know (Graph doesn't say where a trashed message came from), the undo moves it back to the folder it was in before.

## Navigation in the URL hash

**Decision.** The current place (account, mailbox or All inboxes, message, search, full-screen composer, Settings, calendar view, date and event) lives in the URL hash.

**Why.** Back works everywhere, also between the single panes on phones; links and reloads land in the same place; a static host needs no rewrite rules.

**Trade-offs.** The router has to tell its own navigation from the browser's (it keeps a depth counter in `history.state`), and some state (focus inside a list) is mirrored into the URL with `replace` so it doesn't flood the history.

## Tokens: short-lived, never in localStorage

**Decision.** OAuth tokens live in memory or sessionStorage, never in localStorage. In the desktop app, refresh tokens are kept only by the native side (encrypted, the key in the OS keychain); the interface only ever sees short-lived access tokens. See [security.md](security.md).

**Why.** localStorage outlives the session and is readable by any script on the origin; a stolen access token expires within an hour, a refresh token wouldn't. Keeping refresh tokens out of the web layer entirely means an XSS in the interface can't take long-lived access.

**Trade-offs.** In the web app Google sessions end after about an hour without interaction (the app renews them on the next click when it can, otherwise it shows Reconnect). The desktop app avoids this.

## HTML mail in a sandbox, remote content blocked

**Decision.** HTML mail is sanitized with DOMPurify and rendered in an iframe sandbox without scripts, with a Content Security Policy inside the iframe that blocks every remote request until the user allows images for that message (or always, or for trusted senders).

**Why.** Mail is untrusted input. Sanitizing alone has a history of bypasses; the sandbox and the CSP make a bypass harmless (no scripts, no tracking pixels, no remote CSS).

**Trade-offs.** Some newsletters look broken until images are allowed. HTML mail keeps its own (light) design in dark mode, since rewriting senders' colours breaks too many layouts.

## Messages by default, conversations as an option

**Decision.** The list shows one row per message; conversation view (one row per conversation) is a setting, off by default.

**Why.** One row per message behaves the same for every provider, including IMAP, which has no conversations. Conversations came later, on top, using each provider's own grouping (Gmail threads, Outlook's conversation ID).

**Trade-offs.** Actions on a conversation need rules: flags and labels go on all its messages; moves in folder accounts only take its messages in the current folder (like Outlook), so sent replies stay in Sent Items.

## Translations without a library

**Decision.** English and German texts live in typed catalogues (`src/i18n/texts`), German typed against English, read with `useT()`; an ESLint rule flags literal words in the UI.

**Why.** Two languages don't need a library. Types make a missing German text a build error, and texts with parameters are plain functions (plurals and word order included). Dates and numbers come from `Intl`.

**Trade-offs.** No translation tooling for outside translators; adding a third language means adding a third object everywhere.

## A desktop app with Tauri, and no proxy

**Context.** IMAP, SMTP and CalDAV need raw sockets or CORS-free HTTP, which browsers can't provide. A hosted proxy would break the "no backend" principle.

**Decision.** action0 also ships as a Tauri 2 desktop app with the same React UI and a small Rust side. It's the only home for protocols the browser can't speak; there is no proxy. Releases are built by CI with signed auto-updates.

**Why Tauri over Electron.** Small installers (it uses the system's web view), a native side in Rust with a strict capability model (the UI can only call the commands it's given), and a path to Android and iOS. Electron would bundle Chromium (larger, but identical rendering everywhere) and a Node.js side. Both are free and open source.

**Trade-offs.** Rendering differs slightly between WebKitGTK (Linux), WebKit (macOS) and WebView2 (Windows). Sign-in needs separate "desktop app" OAuth clients, since Google blocks embedded web views; the system browser and a loopback redirect are used instead. See [desktop-app.md](desktop-app.md).

## Android from the same Tauri project, without a server

**Context.** Phones are the main place people read mail, and the desktop app's Rust side (networking without CORS, the vault, later IMAP and CalDAV) is worth having there too. There's still no server.

**Decision.** The Android app is the Tauri project with an Android target and a small Kotlin plugin. Google accounts use Google Play services (Google's supported way on Android; it hands out access tokens, so no Google refresh token lives on the phone). Microsoft accounts use a Custom Tab with PKCE and an `msauth://` redirect, like other mail apps without Microsoft's SDK. New mail is found by a WorkManager job every 15 minutes or so, which calls a small Rust check, because Android doesn't run the web view in the background. The APK ships in the GitHub Release; Google Play later.

**Trade-offs.** No push without a server, so background notifications can be late. Phones without Play services can't add Google accounts. Company tenants that require managed devices need Microsoft's broker, which this doesn't use. Kotlin code has no automated tests and is tried on the emulator. iOS follows as its own feature (it needs an Apple Developer account). See [android.md](android.md).

## Spelling from the platform's own checker

**Context.** Browsers check spelling on their own, but not every web view does: WebKitGTK and macOS's WebKit have it off in apps, WebView2 checks only the display language, and the Android web view doesn't always check.

**Decision.** The editors use each platform's checker, and action0 turns it on where it's off: the Linux app sets WebKitGTK's languages (several at once, chosen in Settings from the installed hunspell dictionaries), the macOS app turns on checking while typing, Android gets `spellcheck="true"` explicitly. Settings → Writing turns it off, and says where the languages are set elsewhere.

**Why not action0's own checker.** Shipping dictionaries (several megabytes each) and a checker in JavaScript or WebAssembly would look the same everywhere, but duplicate what the systems already do well, with their personal word lists and the phone keyboard's corrections. A grammar service like LanguageTool would send drafts to a server.

**Trade-offs.** Underlines and suggestions look different on each platform, the Windows app checks only the display language, and the AppImage may not find the system's dictionaries outside Debian and Ubuntu.

## All inboxes: per-account lists, merged; a context account

**Context.** All inboxes shows every account's Inbox as one list, while everything else (reader, replies, shortcuts like `g i`) was built around one account per route.

**Decision.**

- Each account's part is its own cached list (the same query keys as a single Inbox), merged by date in the UI layer; a page only shows rows down to the date every account with more pages has reached.
- Rows, focus and selection use a `MessageKey` (account + message ID) instead of a bare message ID.
- The route keeps a _context account_, the account of the open message, so code that reads `route.accountId` (reader, replies, `g i`) keeps working unchanged.

**Why.** Reusing the per-account caches means optimistic changes, live updates and persistence work in All inboxes without knowing about it. Qualified keys matter because message IDs only need to be unique within an account (IMAP UIDs collide easily). The context account kept the change contained instead of turning every route consumer into a multi-account one.

**Trade-offs.** Actions have to group their targets by account (one undo step per account under one toast), and moving and labels only work within one account.

## What can be edited is described per mailbox kind

**Context.** Gmail labels can be renamed, coloured, nested and hidden; Outlook folders can be renamed and nested but not coloured; Outlook categories can only change colour.

**Decision.** Capabilities describe editing per mailbox kind (`mailboxEditing: { folder?, label? }`), and undo in folder accounts finds a message's folder by kind instead of assuming the first mailbox is the folder.

**Why.** An Outlook account has two kinds of own mailboxes with different rules; one set of flags per provider couldn't express that.

## A fixed way of working

**Decision.** Every feature goes through the same steps: plan (approved), code outline (approved), implementation tested by hand, then a pull request into the protected `main`, which CI must pass. Decisions are recorded in `CLAUDE.md`. See [development.md](development.md#workflow).

**Why.** UX quality is the point of the project; agreeing on behaviour before writing code, and testing by hand before merging, catches what automated tests can't.
