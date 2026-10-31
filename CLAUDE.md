# action0 mail client

A mail client built as a purely static web app (HTML, TypeScript, CSS) with no backend. It authenticates with OAuth in the browser and calls the provider's REST API directly. It exists because the Gmail web UI is a poor user experience, so UX quality is the point of the project.

## How we work (mandatory)

Every feature goes through these steps, one feature at a time. Never skip or merge steps.

1. **Plan**: discuss and plan the feature with the user. Wait for explicit approval.
2. **Code outline**: show the planned code changes, as a diff or a detailed outline with comments. Discuss, then wait for explicit approval.
3. **Implement**: build it, then ask the user to try it and wait until they confirm it works. With every request to test, include a recap: a checklist of everything to test, and for each item how best to test it (demo or real account, exact steps, what should happen). Call out what automated tests and the headless browser couldn't verify.
4. **Commit and push**: only after step 3 is confirmed. Work happens on a feature branch; push it and open a pull request. `main` is protected: CI (the `check` job) must pass, and the user merges.

Whenever a decision is needed from the user, offer multiple-choice options (AskUserQuestion) with the recommended option first. Never make the user type out an answer.

Once a decision is approved, record it under "Decisions log" below so it persists across sessions.

## Roadmap

1. Gmail, read-only: Gmail REST API, `gmail.readonly` scope, Google Identity Services (GIS) token model.
2. Gmail features added one at a time: archive, move/label, compose, reply, search, and so on.
3. Exchange Online through Microsoft Graph: MSAL.js, SPA auth code flow with PKCE.
4. IMAP/SMTP (and CalDAV). Browsers can't open raw TCP connections, so these come only to the desktop and Android apps, through their native side, with no proxy (see the desktop app decisions). Keep the provider abstraction ready for such an adapter so it can be added without restructuring.

## Backlog

Features the user asked for, in order; each goes through the four steps when it's next. Remove an entry once its PR is merged.

_Empty. Shelved until the user brings it back: iOS app (needs an Apple Developer account)._

## Architecture rules

- Each concern has a clear boundary: auth, provider/API access, caching, state, UI. They connect only through TypeScript interfaces. Keep it modular.
- The UI depends only on the provider-agnostic `MailProvider` interface and the domain model, never on Gmail, Graph or IMAP types. Gmail is the first implementation.
- The domain model must support both Gmail labels (a message can have several) and the folder model of Exchange/IMAP. See the decisions log for the agreed model.
- Provider IDs and pagination cursors are opaque strings. The UI never parses them.
- TypeScript strict mode. React + Tailwind, built with Vite.

## Security and storage rules

- Browser storage is only for settings, UI state and short-lived caches with a TTL. Never persist mail content long-term.
- OAuth tokens live in memory or sessionStorage, **never** in localStorage. In the desktop app, refresh tokens live only in the OS keychain (handled in Rust); the UI only ever holds short-lived access tokens in memory.
- AI service API keys in the web app live in sessionStorage; only when the user ticks "Remember in this browser" for that service does its key go into localStorage (the one opt-in exception). In the apps, AI keys and ChatGPT sign-ins live only in the vault.
- HTML mail is sanitized (DOMPurify) and rendered in a sandboxed iframe. Remote images, and any other remote content, are blocked by default.

## UX principles

- Three-column layout: (a) accounts and folder tree, (b) message list of the selected folder, (c) selected message.
- Responsive, and it must work on mobile. On narrow screens the columns collapse:
  - the tree becomes a drawer
  - on phones, one pane is shown at a time, navigated through the URL hash so the back button works
  - every interaction must also work by touch: no hover-only controls, touch targets at least 44px, and a touch alternative to drag and drop
- Never force unnecessary clicks.
- Drag and drop moves messages into folders or labels.
- Keyboard shortcuts everywhere. For example, `a` archives the current message or the selection. The list supports multi-select.
- Undo wherever possible: every action that changes mail gets an optimistic update, an undo toast and `z`. If an action can't be undone (e.g. permanent deletion), it asks for confirmation instead.

## Quality rules

- TSDoc for public interfaces. The README covers setup, including creating the Google Cloud OAuth client.
- `docs/` is the developer documentation (architecture, domain model, providers, decisions, development, testing, building, releasing, desktop app, security). Keep it current when a change affects what it describes.
- Tests use Vitest + React Testing Library. Provider APIs are always mocked; tests never hit real APIs.
- ESLint (strict) and Prettier for deterministic formatting.
- GitHub Actions CI requires tests, lint and format checks to pass on PRs.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (port is fixed: it is the OAuth origin). Demo: `/?demo`.
- `npm run check`: everything CI runs (typecheck, lint, format check, tests, build). Run it before handing work over. For the desktop app also `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri/` (CI runs them too).
- `npm run app:dev` / `npm run app:build`: the desktop app (Tauri).
- `npm run android:dev` / `npm run android:build`: the Android app (`scripts/android-setup.sh` installs the toolchain into the home folder first). Android-only Rust is linted with `cargo clippy --target aarch64-linux-android` (see `docs/android.md`).
- `npm test`, `npm run lint`, `npm run format`: individual steps.

## Code conventions

- Module layout and import rules: see `docs/architecture.md`. ESLint enforces that `ui/`, `data/`, `state/`, `keyboard/` and `compose/` never import `providers/` or the concrete auth sessions (`auth/google/`, `auth/microsoft/`, `auth/native/`), that they never import the AI assistant's protocols, `ai/client` or `ai/webBackend` (wired in `src/app`), and that only `src/platform/native/` imports `@tauri-apps/*` (everything else uses the `Platform` interface).
- Tests sit next to the code (`*.test.ts(x)`). Helpers live in `src/test/`. Gmail and Graph tests run in the Node environment against MSW (`onUnhandledFrame: "error"`); UI tests render the whole app with `renderApp()` and the in-memory provider.
- Interfaces that get passed around as functions (subscribe, store actions, router) use function-typed properties, not method syntax (`@typescript-eslint/unbound-method`).

## Decisions log

_Approved decisions go here, newest last, one line each with a short rationale._

- **Mailbox model, JMAP-style (RFC 8621):** a message has a set of `mailboxIds`. Each `Mailbox` has `kind: 'folder' | 'label' | 'view'` (folder = exclusive, label = non-exclusive, view = virtual/query-backed, never a drop target), an optional `role` (inbox, sent, drafts, trash, junk, archive, all, flagged) and a `parentId`. Read/unread and starred are flags (`seen`, `flagged`), not mailboxes. Write operations are intents (archive, move, add label, delete) that each provider translates, gated by provider capabilities. Rationale: the one model fits Gmail, Exchange and IMAP without provider branches in the UI.
- **Message list granularity:** one row per message, not per conversation. Rationale: same behavior for every provider. Conversation grouping may come later as an option.
- **Data layer:** TanStack Query for server state (cache, TTL, revalidation, sessionStorage persistence, later optimistic mutations); Zustand for UI state. The provider layer itself does no caching.
- **Accounts:** multi-account support (several Gmail accounts) from feature 1 on.
- **Feature 1 plan approved** (scaffolding + Gmail sign-in + read-only three-column view):
  - Tokens go in sessionStorage. The GIS token is refreshed on user interaction near expiry, with a "Reconnect" bar as fallback.
  - The account list (provider + email, used as login hint) goes in localStorage.
  - Opening a folder shows the newest message immediately.
  - URL-hash routing (account/mailbox/message).
  - Demo mode backed by the fake provider.
  - Remote content is blocked by a CSP `<meta>` inside the sandboxed iframe, on top of DOMPurify.
  - Package manager: npm.
- **Responsive/mobile in feature 1:** the full responsive shell is part of feature 1. Rationale: building the layout shell once is cheaper than reworking it later.
  - Breakpoints: three resizable columns at ≥1024px; tree as a slide-over drawer with list + reader at 640–1024px; one pane at a time below 640px.
  - Panes are driven by the URL hash, so the back button goes reader → list → tree.
  - Touch: tap opens a message, long-press starts multi-select, targets are ≥44px, nothing depends on hover. Phones get a "Move to…" sheet instead of drag and drop when moving arrives.
  - Mail iframe gets a viewport meta tag; wide mails scroll or scale inside the frame, never the page.
  - `dvh` units and safe-area insets.
  - A PWA is a possible separate feature later.
- **Tooling versions:** TypeScript 6.0.x, not 7, because typescript-eslint only supports versions below 6.1. Upgrade once it supports 7. ESLint 10 with eslint-plugin-jsx-a11y; an npm `overrides` entry accepts jsx-a11y's outdated peer range (it was verified to work on ESLint 10). Remove the override once jsx-a11y declares ESLint 10 support. ESLint 9 is end of life.
- **Go-to shortcuts:** `g` then the first letter of the mailbox (`g i`, `g s`, `g d`, `g a` for All Mail). `a` on its own is reserved for archive. Rationale: one consistent scheme; sequences don't collide with single keys.
- **Branch workflow:** `main` is protected (required CI check `check`, changes only via pull requests, admins included). Each feature gets its own branch and PR; the user merges after CI passes. The very first commit went to `main` directly to bootstrap the repo.
- **Feature 2 (archive + read/unread) decisions:**
  - Gmail accounts switch to the `gmail.modify` scope; read-only tokens trigger a one-click reconnect.
  - Opening a message marks it read after it has been on screen for 1.5 s.
  - After archiving, the cursor moves to the next message below, or the one above at the end of the list.
  - Shortcuts: `a` archive, `Shift+I` mark read, `Shift+U` mark unread, `z` undo.
  - Write operations are optimistic with rollback, and show an undo toast.
- **Feature 3 (move/label + star) decisions:**
  - A plain drag moves: it removes the current mailbox's label and adds the target. Ctrl/Alt-drag only adds the label. Touch uses the pickers instead of drag and drop.
  - `v` opens the Move to… picker and `l` the Labels picker. Changes in the label picker apply when it closes (Enter or click outside), as one undoable action; Esc cancels.
  - Spam and Trash are not move targets yet. They come with a separate delete/spam feature.
  - Starring is included: `s` and clickable stars.
- **Feature 4 (delete + spam) decisions:**
  - Delete moves to Trash and Shift+S reports spam. Inside Trash and Spam the same key undoes it: Delete restores, Shift+S means "not spam".
  - Trash and Spam become drag and picker targets. Trashed or spam messages appear in no other list.
  - Permanent deletion is included: "Delete forever" (Shift+Delete, in Trash and Spam only) and "Empty Trash/Spam". It always asks for confirmation, with Cancel as the default button. This needs the full-access scope `https://mail.google.com/`, so accounts reconnect once.
- **Add account wizard decisions:**
  - "Add account" opens a wizard: choose the account type, then authorize.
  - When Google isn't configured, the wizard shows the Google Cloud checklist and accepts the client ID. It's stored as a setting in the browser; `VITE_GOOGLE_CLIENT_ID` still works and takes precedence.
  - Account types that don't exist yet (Exchange, IMAP) appear as greyed-out "coming later" cards.
  - After connecting, the new account's Inbox opens.
- **Search decisions:**
  - The left column has a folder/label filter (`g f`). Matches show with their parent mailboxes, and ↓/Enter/Esc work in the field.
  - Mail search runs on the server (Gmail's `q`, operators included) as you type, about 0.4 s after the last keystroke. It searches the current folder, with a one-click switch to "Everywhere". `/` focuses the field. The search is part of the URL.
  - The list sorts newest or oldest first, remembered per browser. Gmail only lists newest first, so "Oldest first" fetches all message ids first and then loads details page by page.
- **Composer decisions:**
  - Scope: new mail, autosaved drafts (also reopened from Drafts), and reply, reply all and forward. Adding your own attachments is a separate feature that comes next.
  - The editor is basic rich text built on Tiptap (bold, italic, underline, links, lists, quote). Mail is sent as HTML plus a plain-text version.
  - On desktop the composer is docked at the bottom right and can be minimized or enlarged; one composer at a time. On tablets and phones it's full screen and part of the URL, so Back closes it and saves the draft. Replies use the same window.
  - Shortcuts: `c` compose, `r` reply, `Shift+R` reply all (`a` stays archive), `f` forward, `Ctrl/⌘+Enter` send.
  - Drafts save to the provider's Drafts about 2 s after typing stops and on close, never to browser storage.
  - Sending waits 30 s with "Undo" and "Send now". Leaving the page meanwhile asks first; a mail that didn't go out stays a draft.
  - Replies and forwards keep the original as-is (sanitized, collapsed, removable) inside Gmail's quote marker. Forwards include the original's attachments.
  - Address suggestions come from Google Contacts (People API: contacts and "other contacts"), with recent mail as the fallback. This adds two read-only scopes, so accounts reconnect once, and the People API has to be enabled in Google Cloud.
- **Attachments decisions:**
  - Received attachments: images open in an in-app viewer (← / → between them, Esc closes, Download), PDFs in the browser's PDF viewer in a new tab, everything else downloads. Every attachment also has a Download button. HTML, SVG and XML files are never opened as pages, only downloaded.
  - Files get into a mail through the paperclip (file picker), by dropping them onto the composer, by pasting, or by dropping them anywhere on the app while no composer is open (that starts a new mail).
  - Images dropped or pasted into the text are inline, like Gmail; other files, and images dropped elsewhere on the composer, are attachments.
  - At most 25 MB of attachments per mail (Gmail's limit, inline images included), with a clear message beyond that. Files are saved with the draft; drafts with more than 1 MB of files save every 30 s. Large mails use Gmail's resumable upload.
- **Live updates decisions:**
  - Every connected account is checked for changes every 60 s while the app is in front and every 5 min in the background, and immediately when the tab comes back or the network returns. Gmail uses its history API, behind a provider-neutral `changesSince(token)`.
  - Changes are applied to cached lists, counts and the open message in place (no reloading, no jumping). A "↑ N new messages" button appears when the list is scrolled down. Open searches refresh.
  - Desktop notifications: a bar asks once; only new unread Inbox mail, only while the app isn't in front, grouped when several arrive; clicking opens the message.
  - The tab title shows the unread count of all inboxes across accounts, or "Reconnect" when Google access has run out (it can only be renewed on user interaction).
  - The demo account receives a message every couple of minutes, so this can be tried without Gmail.
- **Unsubscribe and label management decisions:**
  - Newsletters (with `List-Unsubscribe`) get an Unsubscribe button in the reader. It uses one-click (RFC 8058) when offered, else sends the unsubscribe mail, else opens the sender's page. It can't be undone, so it always asks first (Cancel is the default).
  - The production CSP allows `connect-src https:` so one-click requests can reach the sender's server. Rationale: remote images may already load from anywhere once allowed, so this barely widens what the app can reach.
  - Labels: "Create label 'X'" in the Labels and Move pickers (creates and applies), "New label" in the tree, a ⋯ menu on labels in the tree (button on the selected label, right-click, long-press) and a "Manage labels" list that includes hidden labels.
  - Rename, colour (the provider's palette), parent and "show in folder list" are editable and undoable; renaming a parent renames its sublabels. Deleting a label asks for confirmation. System mailboxes can't be edited.
- **Theme decisions:**
  - A System / Light / Dark switch: three small icon buttons next to "action0" at the top left, the current one highlighted. System is the default and follows the OS.
  - The choice is a per-browser setting (localStorage), applied before the first paint so there's no white flash. Native controls (scrollbars, dropdowns) and the phone's address bar follow it.
  - HTML mail keeps its own design (light) in dark mode; plain-text mail follows the theme. No keyboard shortcut.
- **Settings decisions:**
  - A ⚙ button next to the theme switch opens Settings: a large dialog on desktop, full screen on phones, part of the URL so Back closes it. Changes apply immediately (no Save button). App settings are per browser (localStorage); signatures live in Gmail.
  - General: theme (also stays in the header), list density (comfortable / compact; rows stay ≥44px on touch), after archive or delete (next below / above / back to the list).
  - Reading: mark as read (immediately / after 1.5 s / only by hand), remote images (ask / always / ask but remember trusted senders, with an "Always from this sender" button; the list stays in this browser).
  - Writing: undo send (off, 5, 10, 20, 30 s; default 30); signatures per send-as address, edited in action0 and saved to Gmail (optional `gmail.settings.basic` scope, so accounts reconnect once; declined means read-only with "Allow editing"). The composer gets a From field when there are several addresses; replies use the address the original was sent to. The signature is its own block after your text and above the quote (no "--" line), sent exactly as stored in Gmail so its formatting survives; × removes it, changing From swaps it, its text is edited in Settings (which warns when the editor would drop formatting).
  - Notifications: on/off; on asks the browser, blocked explains how to unblock, off hides the bar.
  - Conversation view is its own feature next; its switch (off by default) goes into Settings then.
- **Conversation view decisions:**
  - A switch in Settings → Reading, off by default (greyed out for accounts whose provider has no conversations). On: the list shows one row per conversation (senders with count, subject, newest snippet and date; bold if anything is unread, star/paperclip if any message has one); a conversation shows wherever one of its messages is.
  - Reader: oldest first, the newest and unread messages open, older read ones collapsed to one line; your sent replies and drafts (with Edit) show in place; Trash/Spam messages are left out except in Trash/Spam. Each message has its own Reply / Reply all / Forward and star.
  - Archive, labels, move, delete, spam and read/unread act on the whole conversation (optimistic, undoable); `s` stars the newest message or unstars all; opening marks the unread messages read (per the mark-as-read setting).
  - Search returns conversations; live updates patch rows in place and append to an open conversation.
  - Keys: j/k between conversations; n/p between messages and Enter opens/closes the one at the cursor; r / Shift+R / f answer that message (the newest by default).
- **German interface decisions:**
  - The language follows the browser; Settings → General offers Automatic / English / Deutsch (per browser). `lang` on <html> follows it.
  - German text uses "du". Everything the app says is translated (buttons, menus, dialogs, settings, toasts, errors it writes itself, shortcut help, screen-reader labels); dates and numbers use the browser's formatting for the language (de-AT: "Jänner").
  - Replies and forwards in German get "Am 16.10.2026 um 20:59 schrieb Anna Berger:"; subjects keep Re:/Fwd:.
  - Not translated: shortcut keys, Gmail's own error texts, the demo's sample mails, README and code.
  - A typed English/German catalogue without a library (missing German text fails the build) and a lint rule against untranslated UI text.
- **Microsoft accounts (Exchange / Outlook through Graph) decisions:**
  - Work/school (Microsoft 365, Exchange Online) and personal (Outlook.com) accounts, one Entra app registration (SPA, "any organisation and personal accounts"). MSAL.js popup with auth code + PKCE; tokens in sessionStorage (MSAL renews silently for about 24 h, then the Reconnect bar). The wizard shows the Entra checklist and takes the client ID (stored per browser; `VITE_MICROSOFT_CLIENT_ID` takes precedence).
  - Parity with Gmail except labels: folder tree with roles (Outlook's internal folders hidden), a Flagged view (the star is Outlook's flag), search, archive, read/unread, move, delete, spam, delete forever, empty, compose/drafts/attachments, People suggestions, unsubscribe, live updates. Undo puts mail back into the folder it came from.
  - Signatures for Microsoft accounts are edited in action0 and stored per browser (Graph can't read Outlook's). From shows only the account's address (Graph can't list aliases).
  - Folder management is included, reusing the label menus in folder wording (create, rename, move, delete; no colours or hiding). Deleting a folder moves it and its mail to Deleted Items.
  - System folders of Microsoft accounts use Outlook's names in both languages (Deleted Items / Gelöschte Elemente, Junk Email, Sent Items, Flagged / Gekennzeichnet), so the tree matches Outlook and the folder texts.
  - Later, as separate features: conversation view for Microsoft accounts, Outlook categories as labels, Focused/Other.
- **Conversation view for Microsoft accounts decisions:**
  - The existing Settings → Reading switch (one for all accounts, per browser) now covers Microsoft accounts. Conversations are Outlook's own (its conversation ID); list, reader, keys, search and live updates behave as for Gmail.
  - In folder accounts, archive, move, delete and spam on a conversation act on its messages in the current folder (like Outlook; sent replies stay in Sent Items); in views (Flagged, All mail) on all of its messages. Read/unread and star act on the whole conversation as before.
- **Calendar decisions:**
  - First calendar feature: view, tick/untick, event details and Accept / Maybe / Decline (in the calendar and in invitation mails). Creating and editing events is the next feature; CalDAV comes later through the apps' native side, like IMAP (no proxy); event reminders later.
  - Sources: Google Calendar API and Microsoft Graph calendars of every account, and iCal URLs (also `webcal://`) that load only when their server allows browser access (CORS), with a clear message otherwise. iCal URLs are saved in this browser with the settings (they can be secret; marked in the list, Remove offered), refreshed every 15 min.
  - Calendar access is optional per account (separate scopes/consent): mail keeps working, the calendar list offers "Allow calendar" per account; new accounts are asked when they connect.
  - A Mail | Calendar switch at the top left, part of the URL (Back works); `g c` / `g i`. Left column: small month, calendars grouped by account with colour and checkbox (remembered per browser); drawer on phones and tablets.
  - Views: week (time grid + all-day row), month and agenda on desktop; day and agenda on phones. Today (`t`), ←/→ or j/k, `w`/`m`/`d`/`a`. Locale week start, local time zone, repeating events expanded, overlaps side by side.
  - Event details (panel on desktop, own screen on phones) with sanitized description, meeting link, organizer and attendees' answers. RSVP is optimistic with undo; invitation mails show the same buttons and whether the time clashes.
  - The demo account gets a sample calendar and an invitation mail. Calendars refresh every 5 min, on tab return and after own changes; events are cached like mail lists (sessionStorage, short TTL).
- **Creating and editing events decisions:**
  - Your own events (you organize them, or there's no organizer) in writable calendars can be created, edited and deleted; invitations from others keep only the answer buttons; iCal and read-only calendars stay read-only. Fields: title, all-day, start/end (moving the start keeps the length), calendar (any writable one; the last used is remembered; fixed for existing events), location, video call (Google Meet / Teams where the calendar allows it), guests (address suggestions as in mail), repeat, description (the mail rich-text editor). New events use the browser's time zone; edited ones keep theirs. Reminders, colours, busy/free and attachments come later.
  - Creating always opens the full editor (panel on desktop, over the calendar on tablets, own screen on phones; part of the URL, Back cancels and asks when there are changes): from a click or a drag across empty time in day/week view, a day in month view (all-day), `c` or "New event". A ghost block marks the time meanwhile. Keys: `c` new, `e` edit, Delete, Ctrl/⌘+Enter save, Esc cancel.
  - Dragging moves events (15-min snap, across days) and the bottom edge changes their length; month view drags to another day. Works with the mouse and on touch (long press lifts the event, a handle resizes, the grid scrolls at its edges, letting go outside cancels; long press on empty time picks a range for a new event).
  - Repeats: daily, every weekday, weekly on that day, monthly on that date, yearly; ending never or on a date. Changing or deleting an occurrence asks "This event / This and following / All events"; "this and following" splits the series (the old one ends, a new one starts; one-off changes after that point are lost, and the question says so). Rules action0 can't show stay as they are, shown as "Custom".
  - Guests: on Google calendars every change to an event with guests asks "Send update to guests?" (Send / Don't send / Cancel). Microsoft always notifies guests, so the editor and Delete say "Guests will be notified" instead.
  - Every change is optimistic with an undo toast and `z`. Undoing a change to an event with guests asks "Notify guests?" again (Google). Deleting a Microsoft meeting with guests asks first and can't be undone (bringing it back would be a new invitation).
- **Desktop app (Tauri) decisions:**
  - action0 also ships as a Tauri 2 desktop app (Linux, Windows, macOS) with the same React UI; the static web app stays as it is (Gmail and Microsoft only). The app is the only home for IMAP and CalDAV (separate features next); no proxy. Android/iOS come later as their own feature. Rationale: one self-contained solution, a path to mobile, small and locked down by default.
  - Sign-in in the app goes through the system browser (Google blocks embedded web views): auth code + PKCE with a loopback redirect, a "Desktop app" OAuth client for Google and a "Mobile and desktop applications" platform on the Entra app. Token exchange and refresh happen in Rust. Refresh tokens are kept only in the OS keychain (never in the UI's storage); the UI gets short-lived access tokens in memory. The app stays signed in across restarts.
  - In the app, provider requests go through the native side, so CORS doesn't apply (iCal from any server works; groundwork for CalDAV).
  - Desktop behaviour: external links open in the default browser, attachments save through the system dialog, file drops still reach the composer, window size/position remembered, one instance.
  - Extras: native notifications with the unread count on the dock/taskbar where supported (always in the tray tooltip); a tray icon (closing the window keeps action0 checking mail in the tray, first close says so; Settings: keep running in the tray / quit); start with the system (off by default, starts hidden in the tray); `mailto:` handler (fills a new mail, from the account used last, in the running instance).
  - Releases: a `v…` tag makes CI build installers (Linux AppImage/deb/rpm, Windows, macOS) into a GitHub Release; the app checks for signed updates on start and daily and asks before installing. OS code signing later. The protected `check` job also checks the Rust code.
- **Event reminders decisions:**
  - Reminders are the events' own, as stored at the provider (Google's per-calendar defaults included; Outlook's one reminder per event; iCal alarms). Events without one don't remind. Only ticked calendars; never declined or cancelled events. A background list of upcoming events (refreshed with the calendars) finds them regardless of the view.
  - A due reminder shows as a system notification (click opens the event) and in an in-app reminders panel (bottom left) with Join meeting, Open, Snooze (5 min, 10 min, 1 h, until it starts) and Dismiss. Reminders missed while closed show in the panel (no late notification) until the event ends. The web app reminds only while open; the desktop app also from the tray; phones in-app only. Settings → Notifications: "Event reminders" on/off (on by default).
  - Microsoft reminders come from Outlook's reminder list, and Snooze/Dismiss sync with Outlook (all devices). Google and iCal: snooze/dismiss kept on this device (browser storage, pruned after the event).
  - The event editor gets a Reminders row (presets for timed and all-day events); Google up to 5, Microsoft 1; new events start with the calendar's default. Changes are undoable like other edits. Sound and email reminders aren't part of it.
- **All inboxes decisions:**
  - An "All inboxes" entry at the top of the left column (only with 2+ accounts; combined unread count; `g u`) lists every account's Inbox merged by date, in either order and in conversation view. With 2+ accounts the app starts there. Only this combined view for now; the merged list works by mailbox role so others (Starred, Sent, Drafts) can follow cheaply.
  - Each account gets an automatic colour: a thin bar at the row's left edge in All inboxes, the same colour next to the account in the tree, and the reader names the account.
  - Reader, reply, forward and attachments use the message's account. Archive, read/unread, star, delete and spam work on selections across accounts as one undoable action; Move/Labels (pickers and drag and drop) work within one account and explain otherwise. `g i`/`g s`/… go to that mailbox of the focused message's account.
  - Search in All inboxes searches every account's Inbox ("Everywhere": every whole account), merged by date. An account that needs reconnecting is noted at the top; the others still show.
  - The composer's From lists every account's addresses (everywhere, not only in All inboxes). New mail in All inboxes starts from the account used last (inside one account's mailboxes from that account); switching to another account moves the draft (saved there, deleted in the old one, files kept) and swaps the signature.
- **Outlook categories decisions:**
  - Categories of Microsoft accounts are labels in action0's model (several per message), next to the folders. A "Categories" group under the account's folders lists them in their Outlook colour with unread counts; clicking one lists the mail with it from every folder except Deleted Items and Junk.
  - `l` (worded "Categories" for Microsoft) applies them like labels (apply on close, undoable, "Create category 'X'"); `v` stays folders only. Dragging a message onto a category adds it and the message stays in its folder. The reader shows them as coloured chips; list rows don't show labels or categories.
  - Management (⋯ menu, "Manage categories"): create with one of Outlook's 25 colours, change colour (undoable), delete (asks; mail keeps the name without colour, like Outlook). No rename: Graph can't rename categories, so the menu says so.
  - Conversations show the categories of all their messages; applying one tags every message. Search inside a category searches the account and keeps matches with it. Changes made in Outlook show up with live updates.
  - Needs `MailboxSettings.ReadWrite` (the category list), so Microsoft accounts reconnect once. The work demo account gets categories.
- **Reader toolbar decisions:** the message and conversation toolbars show as many buttons as fit (measured, follows resizing) and put the rest into a ⋯ More menu (icon, name, shortcut; ≥44px rows; keyboard). Back, Archive and Delete (in Trash/Spam: Restore / Not spam and Delete forever) always stay. The others move into ⋯ in this order: Forward, Reply all, Spam, Labels, Move, Reply, Star, Read/unread; on phones Reply, Reply all and Forward go first (the big buttons below the mail do the same). The list's selection bar keeps wrapping.
- **Developer documentation decisions:** a `docs/` folder (index, architecture, domain model, providers, decisions, development, testing, building and deploying, releasing, desktop app, security), written from the code for new contributors, linked from the README. The README stays the entry point with features and setup; its Architecture section is a summary pointing to `docs/architecture.md`. This decisions log stays authoritative; `docs/decisions.md` explains the reasoning.
- **Error and keychain texts decisions:** an Outlook upload that fails at its first chunk says the upload server didn't answer (files up to 3 MB always work); one that fails later says the connection dropped and the next save retries. Without an OS keychain the desktop app says so in Settings → App (with the Linux hint) and the "Connected …" toast adds "until you quit".
- **Release checks decisions:** before any installer is built, the release workflow checks that the tag equals the version in `package.json`, `src-tauri/Cargo.toml` and `Cargo.lock`, that the tagged commit is on `main`, and runs CI's `check` job (reused, not copied).
- **Cleanup decisions:** message ids stay stable across moves and label changes; a provider whose native ids change (IMAP UIDs) keeps a stable one itself (RFC 8474 `EMAILID` or its own mapping), so `MutationResult` carries no id map. The unused `editSignatures` capability and the unused `core:window:allow-hide` permission are gone.
- **Outlook forwards decisions:** forwards are created with Graph's `createForward` (Outlook records them as forwarded, not replied) and reuse the original's attachments Outlook copies into the draft instead of uploading them again; replies keep `createReply`.
- **Context menu decisions:**
  - Right-click, long press on touch, or Menu / Shift+F10 opens a context menu (a popup at the pointer; a bottom sheet on phones); Shift+right-click keeps the browser's menu. Entries follow capabilities, changes are undoable, destructive ones ask.
  - Message and conversation rows: (touch) Select, Open, Open in a new tab (web), Reply, Reply all, Forward, Archive, Delete, Report spam (Trash/Spam: Restore / Not spam, Delete forever), Move to…, Labels/Categories…, Star, Read/unread, Mail from <sender>, Copy sender address, and Show original once that exists. A long press now opens this menu (replacing "long-press starts multi-select"; Select is its first entry). On a selected row the menu acts on the whole selection; on any other row on that row only, leaving the selection.
  - Tree: Open in a new tab (web), Mark all as read (undoable; new provider `markAllRead`), Empty Trash/Spam, New label/folder inside, and for your own mailboxes the existing entries.
  - Reader: a message's header or folded line: Reply, Reply all, Forward, Star, Mark unread, Archive, Delete, Move, Labels, Copy sender address, Mail from <sender> (the mail body keeps the browser's menu).
  - Calendar events: Open, Edit, Delete, Join meeting, Copy link, Accept / Maybe / Decline for invitations (verbs, since the menu has no "Going?" heading; the current answer is checked); a long press that doesn't move opens the menu, one that moves drags.
- **Show original decisions:**
  - Any message's headers and raw source, from the reader's ⋯ More menu, the message context menus (reader and single list rows; a conversation row means its newest message) and Ctrl/⌘+U (like Thunderbird; the composer keeps Ctrl+U for underline). Only for providers with the `rawSource` capability (Gmail, Outlook, demo; IMAP later).
  - Opens in the app: a large dialog on desktop, its own screen on phones, part of the URL so Back/Esc close it. Fetched when opened (`getRawMessage`), kept in memory only, never in browser storage; shown as plain text only.
  - Contents: a summary (Message-ID, date, From/To/Cc/Subject decoded, SPF/DKIM/DMARC badges from the topmost Authentication-Results only, since lower ones could be forged; delivery time), every header in order with a filter, the delivery path (each Received hop and its delay), and the source. Download (.eml; save dialog in the desktop app) and Copy always give the complete original.
  - Large mails: encoded parts over 100 KB show as one line (name, type, size) so the view stays fast.
- **Android app decisions:**
  - The Tauri 2 desktop project gets an Android target: the same React UI in its phone layout and the same Rust side (networking, account vault; IMAP/CalDAV later). iOS follows as its own feature once there's an Apple Developer account (macOS CI, TestFlight). Desktop-only parts (tray, autostart, self-updater, single instance, window state) are off on phones.
  - Sign-in never in an embedded web view. Google on Android uses Google Play services (`AuthorizationClient`, a small Kotlin plugin): access tokens are renewed silently, no Google refresh token on the phone; phones without Play services can't add Google accounts. Microsoft uses Custom Tabs with auth code + PKCE and the `msauth://<package>/<signature hash>` redirect on the same Entra app; its refresh token stays in the vault, whose key moves into the Android Keystore.
  - Phone integration: Android Back follows the URL; attachments open in other apps and are saved/shared through the share sheet; `mailto:` and "Share → action0" start a new mail; notifications for new Inbox mail and the unread badge where the launcher supports it; event reminders stay in-app.
  - Background checks are best effort without a server: an Android WorkManager job (about every 15 min or less often, as the system allows) calls a small Rust check for new Inbox mail (Gmail history, Graph delta) and notifies; the full app updates on opening. Checks while open as today.
  - Distribution: a signed APK in the GitHub Release (built on Linux CI from the `v…` tag; key in secrets), and the app says when a newer one is out. Google Play later as its own step. Known limits go into the README: Google's restricted-scope verification for public releases, Microsoft tenants that require managed devices (Intune broker) not supported yet, sideloading verification from 2027.
- **Spell checker decisions:**
  - The composer uses each platform's own spell checker; action0 turns it on where it's off and ships no dictionaries. Rationale: small, and it uses the system's dictionaries and personal word lists. No grammar, no check before sending.
  - Linux app: WebKitGTK checking with all chosen languages at once, from the hunspell dictionaries installed on the system (chosen in Settings, default from the system languages); suggestions in WebKitGTK's menu. macOS app: turned on (apps have it off by default), language detected by macOS. Windows app: Windows' display language (WebView2 offers no way to add more). Android: turned on explicitly; tapping an underlined word shows Android's suggestions. Web: the browser's checker and languages.
  - Settings → Writing → Spelling: on/off (on by default; mail body, subject, signatures, event title and description); the language list in the Linux app, elsewhere a note on where the languages are set.
- **AI assistance decisions:**
  - Services: Claude, OpenAI and Gemini with the user's API key; OpenRouter by signing in (PKCE, gives a key billed to the user's credit); Ollama, LM Studio and any other OpenAI-compatible server by URL (and key). Sign in with ChatGPT (the user's Go/Plus/Pro plan) in the desktop app through OpenAI's loopback sign-in, tokens only in the vault, with OpenAI's required notes ("Continue with ChatGPT", a one-time plan note, "Using ChatGPT plan · Manage usage"); on Android only if the same sign-in works there; never in the web app (OpenAI's rules). Copilot has no usable API (GitHub Models retired; Microsoft 365 Copilot's Chat API can't write text). Several services can be set up; every AI panel and field has a service/model picker (models from the service's own list, filterable; the last choice remembered per browser).
  - Settings → AI assistant: add (key, sign-in or URL; Test loads the models) and remove services, a privacy note per service (Gemini's free tier may train on input). Web: keys for the session, or in localStorage when "Remember in this browser" is ticked for that service; apps: keys in the vault (a second encrypted file with the same keychain key). No AI buttons anywhere until a service is set up.
  - Reader: one AI panel above the mail (above the thread in conversation view, covering the whole conversation). Summarize (`b`, a toolbar button that is the first to move into ⋯, the ⋯ and context menus) streams a summary with Stop, Copy, Try again, Close; a question field below keeps a short chat while the mail is open (`q` focuses it); Reply with AI opens a reply with the composer's AI field. Answers in the app's language.
  - Composer: ✨ in the editor toolbar or Ctrl/⌘+J opens an instruction field above the editor with quick actions (Shorter, More formal, Friendlier, Fix spelling & grammar, Translate to…). Empty draft: writes the mail (replies from the original); selection: rewrites it; otherwise applies to the whole draft. The text goes straight into the editor as it streams (Stop, Try again, Undo; Ctrl+Z; typing on keeps it); signature and quote are never touched. Replies and rewrites in the language of the mail or draft unless the instruction says otherwise.
  - Mail goes to the AI only on a click, as plain text (From, To, Cc, date, subject, text; no attachments, images or hidden HTML); long threads are cut to the newest messages and the panel says so. A one-time note per service says what's sent where. Answers stay in memory only. The AI has no actions, and its output is shown and inserted as plain text, never HTML. A demo AI with canned answers. Everything ships in one PR.
- **IMAP/SMTP decisions:**
  - "Other mail server" accounts in the desktop and Android apps (the web app says they're app-only), done in Rust (`async-imap`, `mail-parser`, a small own SMTP client, because `lettre` can't use action0's TLS checks and trusted certificates) behind the provider contract; new mail is built by the existing `buildMessage`. No mail on disk: everything loads from the server, cached in memory only.
  - Adding: the address, then the settings found like Thunderbird (the provider's autoconfig, Mozilla's ISPDB, which learns only the domain, then MX), shown and editable; typing them in always works. Gmail and Microsoft addresses are offered their own account types. Password or app password, with links to known providers' app-password pages. Only TLS or required STARTTLS. An untrusted certificate can be trusted once while adding the account, for that account only and revocably; a different one later is refused. Password and settings live in the native vault; a password that stops working shows Reconnect.
  - Yahoo/AOL OAuth (XOAUTH2/OAUTHBEARER) is built now with a configurable client ID, like Google's setup (Yahoo approves mail registrations by hand); otherwise app passwords.
  - Parity with Outlook accounts plus conversations: special-use roles (or names, German ones included), a Flagged view, read/unread, star (IMAP's flag), move, archive (creates "Archive" if there's none), Trash, Junk, delete forever, empty, mark all read; folder management (deleting a folder moves it into Trash, like Thunderbird); server search with `from:`, `to:`, `subject:`, `is:unread`, `is:starred` and words ("Everywhere": all folders but Trash and Junk); sending over SMTP with a copy in Sent, drafts in Drafts, the server's size limit, signatures kept in the app, From = the account's address, suggestions from recent mail; unsubscribe, show original, All inboxes. Invitations show without answer buttons until CalDAV.
  - Conversations from Message-ID / In-Reply-To / References (or the server's thread ids); opening one also finds the replies in Sent and messages in Archive.
  - New mail: checks like the other accounts (CONDSTORE/QRESYNC where the server has them), IDLE on the Inbox in the desktop app, and Android's background check covers IMAP. Stable message ids from the server (EMAILID, X-GM-MSGID) where it has them, else tracked by action0 while it runs. Everything ships in one PR.
- **More From addresses decisions:**
  - IMAP and Microsoft accounts get extra From addresses, kept in the app like their signatures (IMAP can't list aliases; Graph can't either). Gmail keeps its own send-as list.
  - Settings → Writing lists each account's addresses with name, address, an optional Reply-To, "Bcc to myself" and its signature; add, edit (name, Reply-To, Bcc; the address itself is fixed once added), remove (not the account's own) and make default. The composer's From list ends with "Add an address…", which opens that place.
  - Choosing an address sets its Reply-To header and puts it into Bcc when "Bcc to myself" is on (visible, removable), besides its signature.
  - Replies go out from the address the mail was sent to: a set-up one, a `+tag` of one of yours, or any address at a domain the user marked as catch-all for that account (opt-in per domain, so public domains like gmx.at never count), with the default address's name, marked "not set up" in From with one-click "Add".
  - IMAP sends with the chosen address as the SMTP sender, Microsoft with the message's From; a server that refuses shows its reason. No separate SMTP server per address.
- **CalDAV calendars decisions:**
  - Mail server (IMAP) accounts get their CalDAV calendars, and calendar-only CalDAV servers (e.g. Nextcloud, Radicale) can be added like an iCal subscription (Add calendar → CalDAV server); desktop and Android apps only (CalDAV servers don't allow browser access; the web app says so).
  - Full parity with Google/Microsoft calendars: views, details, create/edit/delete own events (no video-call field), drag/resize, series scopes, undo, VALARM reminders (snooze/dismiss on this device), guests, Accept/Maybe/Decline in the calendar and in IMAP invitation mails. Not included: tasks, creating/sharing calendars, free/busy, CardDAV.
  - Server found like Thunderbird/iOS (known providers, DNS SRV on desktop, `/.well-known/caldav`, the mail host), editable. New mail server accounts are asked while connecting; existing ones get "Set up calendar" in the calendar list. Same login as the mail by default, a separate one possible; Rust adds the password only for that account's calendar server (the UI never sees it) and applies its trusted certificate (an untrusted one can be trusted once).
  - CalDAV logic in TypeScript (reusing the iCal parsing and recurrence code) over native requests; sync by the server's change list (sync-collection) or ETags; writes with If-Match, a conflict reloads and says so.
  - Servers that schedule themselves (RFC 6638) send invitations, updates and replies ("Guests will be notified"); otherwise action0 sends them as iMIP mails through the account's SMTP and asks first like Google (Send / Don't send / Cancel). Calendar-only servers without scheduling send through the mail account whose address is the organizer's or attendee's; without one the editor says guests won't be notified.
  - Answering an invitation mail whose event isn't in a calendar yet puts it into the account's default calendar (the one used last for new events, else the first writable) with the answer.
- **CardDAV contacts decisions:**
  - Address suggestions (composer and event guests) from CardDAV address books, desktop and Android apps only. Found with the calendar server's login (same principal's `addressbook-home-set`, or the provider's own contacts host from the known-providers list); accounts that already have a calendar server get them on the next start, no new question.
  - A mail server account uses its own server's address book; accounts without contacts of their own (other IMAP accounts) also get calendar-only servers' address books. Gmail and Microsoft keep theirs.
  - Suggestions: address book matches first, then people from recent mail who aren't in it. Address books load once per run, then only changes; kept in memory only; vCard 3.0/4.0 read with ical.js; searched locally (name, nickname, organization, address; one row per address).
  - Suggestions only: no editing, no contacts view, no photos.
- **Installable web app (PWA) decisions:**
  - The web app installs like an app (Chrome, Edge, Android, iOS/iPadOS Safari "Add to Home Screen", Safari on the Mac "Add to Dock"): manifest with icons from the app icon, a "New mail" shortcut, theme colours. Never in the Tauri apps, which have all of this natively.
  - A small service worker of our own (no Workbox), production builds only: keeps only the app's own files (list made at build time) so it starts offline and says so; never API answers or mail. A new version shows "A new version of action0 is ready" with Reload (nothing reloads by itself; otherwise it's used from the next start).
  - The installed app also gets: the unread count on the app icon (Badging API), the new-mail notifications on phones through the service worker (open or in the background; tapping opens the message), "Use action0 for email links" in Settings (`registerProtocolHandler`, plus `protocol_handlers` in the manifest), and "Share → action0" on Android (share target: text, link and files start a new mail).
  - Installing is offered in Settings ("Install action0", with Safari's steps where there's no button) and once in a bar on phones; the browser's own install icon works too.
