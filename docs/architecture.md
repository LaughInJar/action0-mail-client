# Architecture

action0 is a mail and calendar client that runs entirely on the user's device. The same React code runs as a static web app (no server of its own: it talks to Gmail, Microsoft Graph and calendar servers straight from the browser) and as a desktop app built with Tauri, which adds a small native side in Rust. This document describes how the code is organised, how the layers fit together and how the main flows run from a click to the provider and back.

- [Two shells, one app](#two-shells-one-app)
- [Layers and import rules](#layers-and-import-rules)
- [Module map](#module-map)
- [The composition root](#the-composition-root)
- [Routing](#routing)
- [State](#state)
- [Flows](#flows)
- [Cross-cutting concerns](#cross-cutting-concerns)

The domain types (mailboxes, intents, capabilities) are explained in [domain-model.md](domain-model.md), the provider adapters in [providers.md](providers.md), the native side in [desktop-app.md](desktop-app.md), and the reasons behind the big choices in [decisions.md](decisions.md).

## Three shells, one app

|                   | Web app                                                        | Desktop app                                                                         | Android app                                                                                |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Delivery          | Static files (`dist/`) on any HTTPS host                       | Installers built by Tauri; the same `dist/` inside a native window                  | An APK built by Tauri (`src-tauri/gen/android`); the same `dist/` in a web view            |
| Sign-in           | Google Identity Services and MSAL.js popups in the page        | The system browser with a loopback redirect; tokens exchanged in Rust               | Google through Play services; Microsoft in a Custom Tab with an `msauth://` redirect       |
| Long-lived tokens | None: access tokens in sessionStorage, Reconnect when they end | Refresh tokens in an encrypted vault, its key in the OS keychain                    | Microsoft's in the same vault, its key wrapped by the Android Keystore; none for Google    |
| Network requests  | `fetch` from the page (CORS applies)                           | Through the native side (`net_fetch`), so CORS doesn't apply (iCal from any server) | The same as the desktop app                                                                |
| Extras            | —                                                              | Tray, autostart, `mailto:` handler, native notifications, updater                   | Background check and notifications, Share → action0, `mailto:`, share sheet, release check |

Everything that differs sits behind the `Platform` interface (`src/platform/types.ts`): `web.ts` is the web implementation, `native/` the Tauri ones (`desktop.ts`, `android.ts`), loaded only in an app. Only `src/platform/native` may import `@tauri-apps/*`; the rest of the code asks the platform (`usePlatform()`) to open links, save files, show notifications or set the unread badge. The Android app is described in [android.md](android.md).

`src/main.tsx` decides which shell it is in, builds the services (below) and renders `<App>`.

## Layers and import rules

```
            ui/  (React components, hooks that bind data + state to the screen)
             │
   data/   state/   keyboard/   compose/   i18n/   security/   platform/   ai/
     │       │
 accounts/  ─── auth/ (sessions: Google, Microsoft, native)
     │
 providers/ (Gmail, Graph, iCal, fake) ── implement ──▶ core/ (contracts, domain model)
```

The rules, enforced by `eslint.config.js` where it can:

- **`src/core` depends on nothing**: no React, TanStack, Zustand, and no `../` imports. It holds the domain model (`model.ts`), the provider contracts (`provider.ts`, `calendar.ts`), intents, errors and pure helpers (reply rules, recurrence, time zones, reminders, `mailto:` parsing).
- **`ui`, `data`, `state`, `keyboard` and `compose` never import `providers/` or the concrete auth sessions (`auth/google/`, `auth/microsoft/`, `auth/native/`)**. They see accounts only through `AccountHandle` (`src/accounts/types.ts`): an account, its `AuthSession`, its `MailProvider` and optionally its `CalendarProvider`.
- **Concrete providers are wired in `src/app`**, the composition root.
- **The same goes for the AI assistant**: `ui`, `data`, `state`, `keyboard` and `compose` use its contracts (`src/ai/types.ts`, `backend.ts`, `services.ts`) and never import its protocols, `client.ts` or the web backend ([ai.md](ai.md)).
- **Only `src/platform/native` imports `@tauri-apps/*`.**
- **Providers do no caching**; the data layer (TanStack Query) does.
- **IDs and cursors are opaque.** Only the provider that issued an ID interprets it. The UI combines account and message IDs into a `MessageKey` (`src/core/ids.ts`) but never looks inside the provider's part.
- **Every word on screen comes from `src/i18n/texts`**; ESLint flags literal text in `src/ui`.

## Module map

| Folder           | What lives there                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`      | Domain model, `MailProvider` / `CalendarProvider` contracts, intents and their inverses, `MailError`, ids and keys, compose and reply rules, recurrence, time zones, reminders, `mailto:`                                                                                                       |
| `src/auth/`      | The `AuthSession` contract; `google/` (Google Identity Services token client), `microsoft/` (MSAL, loaded on first use), `native/` (sessions whose tokens come from the desktop app's native side)                                                                                              |
| `src/providers/` | Adapters: `gmail/` (Gmail and Google Calendar REST), `microsoft/` (Graph mail and calendar), `imap/` (IMAP/SMTP through the apps' native side), `ical/` (iCal subscriptions), `mime/` (outgoing MIME), `fake/` (in-memory provider and the two demo accounts), plus each provider's `module.ts` |
| `src/accounts/`  | `AccountRegistry`: restores, adds and removes accounts, one session and provider per account; React hooks (`useAccounts`, `useSignedIn`, …); `mailServer.ts`, the provider-neutral contract for adding IMAP/SMTP accounts                                                                       |
| `src/data/`      | Server state with TanStack Query: query keys, list and message hooks, the merged All inboxes list, optimistic intents and rollback, live sync, drafts and sending, mailbox management, calendar sources, events, edits and reminders                                                            |
| `src/state/`     | UI state with Zustand (`uiStore.ts`), settings (`settings.ts`), focus and selection (`selection.ts`), the hash router (`router.ts`), the event form                                                                                                                                             |
| `src/compose/`   | Outgoing mail HTML: quotes, signatures, the plain-text version, composer content                                                                                                                                                                                                                |
| `src/keyboard/`  | The central command registry: bindings, sequences (`g i`), the help dialog's data                                                                                                                                                                                                               |
| `src/i18n/`      | English and German texts (`texts/`), language choice, `useT()`                                                                                                                                                                                                                                  |
| `src/security/`  | DOMPurify sanitizing and the mail iframe document with its CSP                                                                                                                                                                                                                                  |
| `src/platform/`  | The `Platform` interface, the web implementation and the Tauri ones (`native/`: desktop, Android)                                                                                                                                                                                               |
| `src/ai/`        | The AI assistant without React: contracts, service kinds, protocols (Anthropic, Chat Completions, Responses), streaming, the web backend, the demo AI, mail as text and prompts ([ai.md](ai.md))                                                                                                |
| `src/ui/`        | React components: `layout/` (shell, columns, drawer, toasts), `mailboxes/` (folder tree), `messages/` (list), `reader/`, `composer/`, `actions/`, `pickers/`, `labels/`, `calendar/`, `settings/`, `reminders/`, `desktop/`, `help/`, `ai/`, `common/`                                          |
| `src/app/`       | The composition root (`services.ts`), configuration (`config.ts`), runtime provider setup (client IDs entered in the app), `App.tsx` and its providers                                                                                                                                          |
| `src/test/`      | Test helpers: `renderApp`, the fake Graph server, Gmail fixtures, storage and viewport fakes (see [testing.md](testing.md))                                                                                                                                                                     |
| `src-tauri/`     | The native side of the desktop and Android apps (see [desktop-app.md](desktop-app.md), [android.md](android.md))                                                                                                                                                                                |

## The composition root

`createAppServices()` in `src/app/services.ts` builds everything once (and once per UI test):

| Service          | What it is                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `registry`       | `AccountRegistry` over the provider modules; restores the saved account list from localStorage                                    |
| `queryClient`    | TanStack Query client (`src/data/queryClient.ts`): no automatic retries (providers retry themselves), refetch on focus, 10 min gc |
| `persistOptions` | sessionStorage persistence for queries marked `meta: { persist: true }`, at most 10 minutes old, discarded on a new app version   |
| `uiStore`        | The Zustand store, persisted (partially) to localStorage                                                                          |
| `router`         | The hash router                                                                                                                   |
| `commands`       | The keyboard command registry                                                                                                     |
| `setups`         | Provider setups the user can complete at runtime (Google and Microsoft client IDs entered in the Add account wizard)              |
| `icsFactory`     | Creates the calendar provider of an iCal subscription (the desktop app passes its native `fetch`)                                 |
| `platform`       | The web or desktop `Platform`                                                                                                     |
| `ai`             | The AI assistant: its backend (keys in browser storage, or the apps' vault) and a client per set-up service ([ai.md](ai.md))      |
| `mailServers`    | The apps only: adding IMAP/SMTP accounts (settings lookup, connect) and Yahoo/AOL app registrations ([imap.md](imap.md))          |
| `mailServers`    | The apps only: adding IMAP/SMTP accounts (settings lookup, connect) and Yahoo/AOL app registrations ([imap.md](imap.md))          |

`createDefaultModules()` decides which provider modules exist: Gmail and Microsoft when their client IDs are known (from the build, else from what the user entered in this browser), IMAP in the apps, and always the demo module. When an account is removed, the registry drops all of its cached queries (every query key starts with `["acct", accountId]`).

`App.tsx` puts the services into React contexts and renders `Shell` (`src/ui/layout/Shell.tsx`), which lays out the three columns, mounts the global hooks (navigation defaults, live sync, document title, keyboard, reminders) and the overlays (composer, pickers, dialogs, toasts).

## Routing

All navigation lives in the URL hash (`src/state/router.ts`), so Back works everywhere, also between the panes on phones:

| Hash                                                            | Meaning                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `#/`                                                            | Nothing chosen (on phones: the folder tree)                                              |
| `#/<account>/<mailbox>[/<message>]`                             | A mailbox of an account, optionally with a message open                                  |
| `#/all/<account>/<inbox>[/<message>]`                           | All inboxes; `<account>`/`<inbox>` name the context account (the open message's)         |
| `…?q=<text>[&in=all]`                                           | A search in that mailbox, or everywhere                                                  |
| `…&compose=new\|<draft>[&ca=<account>]`                         | A full-screen composer (tablets, phones), so Back closes it; `ca` is the draft's account |
| `#/calendar/<view>/<date>[/<event>[/edit]\|/new[/<from>/<to>]]` | The calendar                                                                             |
| `…&settings` / `…?settings`                                     | Settings open over the current place                                                     |
| `…&original=<message>&oa=<account>`                             | A message's original (headers and source) open over the current place                    |

`Route` is `null` for `#/`. IDs are URI-encoded but never parsed. The router keeps a history depth counter in `history.state`, so the app knows whether Back stays inside the app.

Settings and a message's original are _overlays_ (`Overlay` in `src/state/router.ts`): they open over the route as a new history entry, so Back closes them; navigating to a new place closes them too, while replacing the place (the cursor moving) keeps them. The original names its account itself, because in All inboxes a row can be another account's than the route's. Closing goes Back if the overlay was opened in this tab, otherwise it's removed from the URL.

`useNavigationDefaults` (`src/ui/layout/`) fills in a place when the URL has none: All inboxes with two or more accounts, otherwise the first account's Inbox. On phones it pushes that on top of the folder tree, so Back leads to the folders.

## State

### Server state (TanStack Query)

Every query key starts with the account (`src/data/keys.ts`), so all data of an account can be dropped at once:

| Key                                                  | Data                                   | Persisted            |
| ---------------------------------------------------- | -------------------------------------- | -------------------- |
| `["acct", id, "mailboxes"]`                          | The account's mailboxes with counts    | yes                  |
| `["acct", id, "messages", mailbox, {search, order}]` | A message list (infinite query)        | without a search     |
| `["acct", id, "threads", mailbox, {search, order}]`  | A conversation list (infinite query)   | without a search     |
| `["acct", id, "message", messageId]`                 | A full message                         | no                   |
| `["acct", id, "thread", threadId]`                   | A full conversation                    | no                   |
| `["acct", id, "senders"]`, `…"contacts"`, …          | Send-as addresses, address suggestions | no                   |
| `["acct", id, "calendar", …]`, `["ics", key, …]`     | Calendars, events, reminders           | events and calendars |

Persistence (sessionStorage, ≤ 10 minutes) makes a reload show the last lists instantly; message bodies are never persisted.

### UI state (Zustand)

`src/state/uiStore.ts` holds what's on screen: the current list's key, focus, selection and anchor (by `MessageKey`), the composer session and pending sends, the AI panel and its answers, open pickers, menus and dialogs, toasts with their undo steps, drag state, column widths, tree expansion, list order, settings, reminder marks and account colours.

Only settings-like state is persisted to localStorage (`partialize`): column widths, tree expansion, list order, settings, reminder marks and account colours. Never mail content. Settings are parsed defensively on load (`src/state/settings.ts`), so an old or edited value can't break the app.

## Flows

### Opening a list

1. A click in the tree (or a shortcut) navigates; the router emits the new `Route`.
2. `useCurrentList()` (`src/ui/messages/useCurrentList.ts`) turns the route into what's listed:
   - a single mailbox: `listSpecOf()` gives the `ListSpec` (mailbox, search, order), and `useMessageList` or `useThreadList` (conversation view) load it;
   - All inboxes: `useUnifiedList()` (`src/data/unified.ts`) builds one source per account (its Inbox, or everything when searching everywhere) and observes their lists with `useInfiniteLists()` (one `InfiniteQueryObserver` per account, since TanStack has no `useQueries` for infinite queries). `mergeByDate()` merges them, showing rows only down to the date every account with more pages has reached.
3. The rows (`ListRow`: `key`, `accountId`, `id`, summary, optional thread) go to `MessageList`, which draws them as a multi-select listbox; `useListController` keeps focus, selection and the URL in sync and loads the next page before the cursor reaches the end.
4. The reader (`ReaderPane`) shows the focused row (on phones: the message in the URL) with `useMessage` or `useThread`, and marks it read after the configured delay.

Because each account's part of All inboxes is its own cached list, everything that patches lists (optimistic changes, live sync) works for All inboxes without knowing about it.

### An action, with optimistic update and undo

1. `useMailActions()` (`src/ui/actions/useMailActions.ts`) turns "the selection or the focused message" into targets (`MessageKey`s) and groups them by account.
2. For each account it builds an intent (`archive`, `set-flags`, `move`, `set-labels`, `trash`, …; see [domain-model.md](domain-model.md)). In conversation view a row stands for its messages: flags and labels go on all of them; moves in folder accounts only on those in the current folder.
3. `usePreviewIntent()` (`src/data/mutations.ts`) predicts the changes with `planChanges()` (`src/data/optimistic.ts`) from what's cached. Nothing changes → an info toast ("Not in the Inbox"), no request.
4. The cursor moves away from rows that will leave the list (`rowsLeaving`, `nextAfterRemoval`), then `useApplyIntent()` runs per account: it cancels the account's list queries, snapshots its cache, patches every cached list, conversation, message and mailbox count, and calls the provider (`runIntent`). If the provider refuses, the snapshot is restored and an error toast shows.
5. The toast offers Undo; `inverseOf()` builds the reverting intents from the actual changes, and `z` or the button runs them the same way. One toast can undo changes in several accounts (`Toast.undo` is a list of steps).

Mailbox management (create, rename, recolour, delete labels/folders/categories) follows the same pattern in `src/data/mailboxActions.ts` and `src/ui/labels/useLabelActions.ts`. Calendar changes do too, in `src/data/eventEdits.ts`.

### Context menus

Right-click, a long press (`useLongPress`) or the Menu key / Shift+F10 (`isMenuKey`) put a `ContextMenuState` into the UI store: what the menu is for (`rows`, `mailbox`, `message` or `event`) and where it opens (`MenuPosition`: at the pointer, or below the focused element, flipping up when there's no room). `ContextMenuHost` (`src/ui/common/`) shows the mail menus (`RowMenu`, `MailboxMenu`, `MessageMenu`); `CalendarApp` shows `EventMenu`, since only it knows the placed events. Going elsewhere (Back included) closes any of them.

- `ContextMenu` is the one component behind them: a popup at the pointer, or a bottom sheet on phones; an ARIA menu with ↑/↓, Home/End, Enter and Esc, and `data-own-keys`, so the app's shortcuts rest meanwhile. A click only counts after a press that started while the menu was open, so the finger lifting from a long press doesn't choose anything.
- The entries reuse the toolbar's items (`mailActionItems`, `answerItems`, turned into entries by `entriesOf`), so a menu offers exactly what the toolbar does, with the same labels and rules. Rows act on the selection when the row is part of it, else on that row only. A message in the reader passes `exact`: the action is for that message, not its conversation.
- `mailboxMenuItems` decides what a mailbox's menu has; the tree uses it to leave out the ⋯ button and right-click handling where the menu would be empty (Sent in the desktop app, which has no "Open in a new tab").
- In the calendar grid a long press lifts an event to drag it (`useGridGestures`); let go without moving, and `onMenu` opens its menu instead. Events that can't be dragged get the long press from `EventChip` itself.
- Shift+right-click keeps the browser's own menu (`wantsAppMenu`).

### Live updates

`useMailSync` (`src/ui/sync/`) checks every account every 60 s while the app is in front, every 5 minutes in the background, and right away when the tab comes back, the network returns or the desktop app asks (`onPollRequest`). For each account, `createMailSync()` (`src/data/sync.ts`) calls `provider.changesSince(token)` (Gmail's history API, Graph's delta queries) and applies the change set to every cached list of that account: rows update, new mail is inserted by date, removed mail goes away, open searches refetch, counts refresh. Nothing reloads, nothing jumps; the list offers "↑ N new messages" when you're scrolled down. New unread Inbox mail is reported as arrivals, which become desktop notifications while the app isn't in front. Sync pauses while the app's own changes are on their way, so it never brings back a row that just left.

### Drafts, sending and undo send

The composer's content lives in the UI store (`ComposerSession`), never in browser storage. `useComposerEffects` (`src/ui/composer/`) saves it to the account's Drafts about 2 s after typing stops (every 30 s for drafts with more than 1 MB of files), when it closes and before sending. `createDraftSync()` (`src/data/drafts.ts`) runs one save after another per composer, remembers the draft ID across saves and keeps attachment bytes in memory so repeated saves don't download them again.

Send saves once more, then moves the session into the send queue (`pendingSends`) for the undo-send period (a setting, default 30 s); a timer sends it, Undo takes it back into the composer, "Send now" skips the wait, and leaving the page meanwhile asks first. Changing From to another account's address moves the draft: its attachments are loaded as bytes, it's deleted in the old account and saved in the new one; a save that finishes for the old account afterwards is ignored.

### Calendar

`useCalendarSources()` (`src/data/calendar.ts`) lists one source per account with calendar access plus one per iCal subscription. `useCalendarData(range)` loads each ticked calendar's events for the visible range and places them (`PlacedEvent`: source, calendar, event). Answers to invitations (`useRespond`) and event edits (`useEventWrites` in `src/data/eventEdits.ts`) are optimistic with undo; repeating events ask for the scope (this event, this and following, all). Reminders (`src/data/reminders.ts`, `src/ui/reminders/`) look at a background range of upcoming events, independent of the view; Outlook accounts take their reminders, snoozes and dismissals from Graph's reminder view.

## Cross-cutting concerns

- **i18n**: `src/i18n/texts/*.ts` keep English and German side by side; `de` is typed as `typeof en`, so a missing German text fails the build. Components use `useT()`. Errors carry a `reason` that the UI translates. Dates and numbers use `Intl` with the chosen locale. See [development.md](development.md#adding-ui-text).
- **Keyboard**: components register `Command`s with `useCommands()`; the `CommandRegistry` (`src/keyboard/registry.ts`) matches single keys and sequences (`g i`, 1 s apart at most), respects each command's `when`, and feeds the help dialog (`?`). Text fields and elements marked `data-own-keys` (the composer, menus) keep single keys to themselves, and while a modal dialog is open the global shortcuts rest (`src/app/AppProviders.tsx`).
- **Responsive layout**: `useBreakpoint()` gives `wide` (≥ 1024 px: three resizable columns), `medium` (640–1024 px: the tree in a drawer) or `narrow` (< 640 px: one pane at a time, driven by the URL). Touch targets are at least 44 px (`pointer-coarse:` variants); a long press does what a right-click does (the context menu, which offers Select on touch); toolbars that don't fit put the rest into a ⋯ menu (`OverflowToolbar`).
- **Accessibility**: the list is a listbox with `aria-activedescendant`, the tree a tree, menus and pickers follow the ARIA patterns; dialogs trap focus (`useFocusTrap`); screen-reader texts come from the catalogue too.
- **Errors**: providers throw `MailError` with a kind (`auth-required`, `not-found`, `network`, `provider`, …) and, where the app can say it better, a `reason` with parameters (`src/core/errors.ts`). Expired sessions show the Reconnect bar; everything else shows as a toast or inline note.
- **Security**: see [security.md](security.md) for tokens, storage, HTML mail and the CSPs.
