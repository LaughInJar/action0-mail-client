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
4. Possibly IMAP/SMTP. Browsers can't open raw TCP connections, so this needs a small proxy. Don't build it yet, but keep the provider abstraction ready for a proxy-backed adapter that can be added without restructuring.

## Architecture rules

- Each concern has a clear boundary: auth, provider/API access, caching, state, UI. They connect only through TypeScript interfaces. Keep it modular.
- The UI depends only on the provider-agnostic `MailProvider` interface and the domain model, never on Gmail, Graph or IMAP types. Gmail is the first implementation.
- The domain model must support both Gmail labels (a message can have several) and the folder model of Exchange/IMAP. See the decisions log for the agreed model.
- Provider IDs and pagination cursors are opaque strings. The UI never parses them.
- TypeScript strict mode. React + Tailwind, built with Vite.

## Security and storage rules

- Browser storage is only for settings, UI state and short-lived caches with a TTL. Never persist mail content long-term.
- OAuth tokens live in memory or sessionStorage, **never** in localStorage. In the desktop app, refresh tokens live only in the OS keychain (handled in Rust); the UI only ever holds short-lived access tokens in memory.
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
- Tests use Vitest + React Testing Library. Provider APIs are always mocked; tests never hit real APIs.
- ESLint (strict) and Prettier for deterministic formatting.
- GitHub Actions CI requires tests, lint and format checks to pass on PRs.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (port is fixed: it is the OAuth origin). Demo: `/?demo`.
- `npm run check`: everything CI runs (typecheck, lint, format check, tests, build). Run it before handing work over. For the desktop app also `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri/` (CI runs them too).
- `npm run app:dev` / `npm run app:build`: the desktop app (Tauri).
- `npm test`, `npm run lint`, `npm run format`: individual steps.

## Code conventions

- Module layout and import rules: see README "Architecture". ESLint enforces that `ui/`, `data/`, `state/` and `keyboard/` never import `providers/` or `auth/google/`, and that only `src/platform/desktop/` imports `@tauri-apps/*` (everything else uses the `Platform` interface).
- Tests sit next to the code (`*.test.ts(x)`). Helpers live in `src/test/`. Gmail tests run in the Node environment against MSW (`onUnhandledFrame: "error"`); UI tests render the whole app with `renderApp()` and the in-memory provider.
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
  - First calendar feature: view, tick/untick, event details and Accept / Maybe / Decline (in the calendar and in invitation mails). Creating and editing events is the next feature; CalDAV comes with a small self-hosted proxy later (also the base for IMAP); event reminders later.
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
