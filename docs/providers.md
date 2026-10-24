# Providers

A provider is an adapter that translates between one service's API and the [domain model](domain-model.md): Gmail through its REST API, Exchange Online and Outlook.com through Microsoft Graph, Google and Microsoft calendars, iCal subscriptions, and an in-memory fake for tests and the demo. Everything above the providers (data layer, state, UI) only sees the contracts in `src/core`, `src/auth/types.ts` and `src/accounts/types.ts`; concrete providers are wired up in `src/app`, and ESLint keeps `src/ui`, `src/data`, `src/state`, `src/keyboard` and `src/compose` from importing `src/providers` or the concrete auth sessions in `src/auth/google`, `src/auth/microsoft` and `src/auth/native` (`eslint.config.js`). This document describes the contracts, each adapter, and how to add a new one.

- [The contracts](#the-contracts)
- [Gmail](#gmail)
- [Microsoft Graph](#microsoft-graph)
- [Calendars](#calendars)
- [Fake provider and demo data](#fake-provider-and-demo-data)
- [Adding a provider](#adding-a-provider)

How requests flow from a click to a provider is described in [architecture.md](architecture.md), testing against mock servers in [testing.md](testing.md), and the desktop app's native sign-in and networking in [desktop-app.md](desktop-app.md). Setting up the Google and Microsoft OAuth clients is covered in the README: [Setting up Google sign-in](../README.md#setting-up-google-sign-in) and [Setting up Microsoft sign-in](../README.md#setting-up-microsoft-sign-in).

## The contracts

### `MailProvider`

`MailProvider` (`src/core/provider.ts`) is one account's mail. Its rules, from the interface's documentation:

- It translates between the provider's API and the domain model, and does **no caching** (that is the data layer's job, `src/data`) and **never opens UI**.
- Every method rejects with a `MailError` on failure (see [Errors](domain-model.md#errors)), except when `signal` aborts, which rejects with the abort reason.
- Ids and cursors it hands out are opaque; callers pass them back unchanged.
- Results are plain, JSON-serializable data (the cache persists some of them to sessionStorage).
- Transient failures are retried inside the provider's HTTP client. The query client deliberately doesn't retry (`retry: false` in `src/data/queryClient.ts`), so retries don't multiply against the provider's quota.

| Group              | Methods                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it can do     | `capabilities` (see [Capabilities](domain-model.md#capabilities))                                                                                    |
| Reading            | `listMailboxes`, `listMessages`, `listThreads`, `getThread`, `getMessage`, `getAttachment`, `getRawMessage`                                          |
| Changing mail      | `archive`, `unarchive`, `setFlags`, `move`, `setLabels`, `trash`, `untrash`, `reportSpam`, `notSpam`, `deleteForever`, `emptyMailbox`, `markAllRead` |
| Writing            | `saveDraft`, `draftIdOf`, `getDraft`, `deleteDraft`, `sendDraft`, `searchContacts`                                                                   |
| Live updates       | `changesSince`                                                                                                                                       |
| Managing mailboxes | `createMailbox`, `updateMailbox`, `deleteMailbox`                                                                                                    |
| Other              | `oneClickUnsubscribe`, `listSenders`, `updateSignature`                                                                                              |

Lists take a `ListMessagesQuery` and return one `Page`:

```ts
export interface ListMessagesQuery {
  readonly mailboxId: MailboxId;
  /** Only messages that match, in the provider's search syntax. */
  readonly search?: string;
  /** Date order; defaults to `"newest"`. */
  readonly order?: MessageOrder;
  readonly cursor?: Cursor;
  readonly limit: number;
}

listMessages(query: ListMessagesQuery, signal?: AbortSignal): Promise<Page<MessageSummary>>;
listThreads(query: ListMessagesQuery, signal?: AbortSignal): Promise<Page<ThreadSummary>>;
```

Searching "everywhere" means searching the mailbox with role `all`. The change-writing methods take message ids and resolve to a `MutationResult`; their effect must match what `planChanges` predicts (`src/data/optimistic.ts`, see [Intents](domain-model.md#intents)), otherwise the optimistic update and the provider's truth disagree until the next reload.

Live updates use one call:

```ts
changesSince(token: SyncToken | undefined, signal?: AbortSignal): Promise<ChangeSet>;

export interface ChangeSet {
  readonly token: SyncToken;
  /** Too many changes, or the token was too old: reload everything instead. */
  readonly reset: boolean;
  readonly changes: readonly MailChange[];
}
```

Without a token it returns just a starting token. Each `MailChange` is `added` or `updated` (with the new summary) or `removed` (with the id), and includes the app's own writes. `src/data/sync.ts` keeps the tokens in memory, applies the changes to cached lists and invalidates the account's cache on `reset`.

### `CalendarProvider`

`CalendarProvider` (`src/core/calendar.ts`) is the calendars of one source: an account, or an iCal subscription. The same rules apply (no caching, `MailError` on failure), with one exception: `requestAccess()` opens UI (a consent popup) and must be called from a click.

| Member                                                     | Meaning                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `canRespond`, `canEdit`                                    | Invitations can be answered; events can be created, changed and deleted              |
| `guestNotices`                                             | `ask` (guests hear about changes only when `WriteOptions.notify` is set) or `always` |
| `maxReminders`                                             | How many reminders an event can have (0: none can be set)                            |
| `reminderSync?`                                            | The provider keeps reminders and their snoozes itself: `list`, `dismiss`, `snooze`   |
| `access`, `requestAccess`, `subscribe`                     | Calendar access (`granted` or `missing`), asking for it, and change notifications    |
| `listCalendars`, `listEvents`                              | Calendars, and occurrences in a `DateRange` with repeating events expanded           |
| `respond`, `findInvitation`                                | Answering an invitation; the event an invitation mail is about (by UID)              |
| `loadForEdit`, `createEvent`, `updateEvent`, `deleteEvent` | Editing; every write resolves to an `EventChange` with an `undo`                     |

The calendar model itself is described in [Calendar model](domain-model.md#calendar-model).

### `AuthSession`

`AuthSession` (`src/auth/types.ts`) is the credentials of one account. Providers only call `getAccessToken()` and, on HTTP 401, `markExpired()`.

```ts
export type AuthStatus = "signed-in" | "expired" | "signed-out";

export interface AuthSession {
  readonly status: AuthStatus;
  /** Expiry of the current access token (epoch ms); undefined for sessions that renew silently. */
  readonly expiresAt: number | undefined;
  /** Never opens UI: rejects with `MailError("auth-required")` if interaction is needed. */
  getAccessToken(): Promise<string>;
  /** Interactive (re-)authentication, from a user gesture. */
  signIn(options?: { readonly askAgain?: boolean }): Promise<void>;
  signOut(): Promise<void>;
  /** Called by the HTTP layer when the provider rejects the token (HTTP 401). */
  markExpired(): void;
  readonly subscribe: (listener: () => void) => () => void;
}
```

A `ScopedSession` adds permissions that are asked for only when needed (calendar access), so mail works without them: `hasScopes(scopes)`, `requestScopes(scopes)` (opens UI) and `subscribe`. The implementations:

| Session                | File                                         | Used for                                                                                                                                                                           |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GoogleAuthSession`    | `src/auth/google/GoogleAuthSession.ts`       | Gmail in the browser: Google Identity Services token model, one-hour tokens, no refresh token; refreshed on the next click or key near expiry (`src/auth/refreshOnInteraction.ts`) |
| `MicrosoftAuthSession` | `src/auth/microsoft/MicrosoftAuthSession.ts` | Microsoft in the browser: MSAL.js (loaded on first use), renews silently; `tokenFor(scopes)` gets calendar tokens                                                                  |
| `NativeAuthSession`    | `src/auth/native/NativeAuthSession.ts`       | Both, in the desktop app: the native side signs in through the system browser and keeps the refresh token                                                                          |
| `StaticAuthSession`    | `src/auth/staticSession.ts`                  | The demo accounts, tests, and single calls with a freshly obtained token                                                                                                           |

The Google and Microsoft sessions and the native one also implement `ScopedSession`. Token storage and the desktop vault are covered in [security.md](security.md) and [desktop-app.md](desktop-app.md).

### `ProviderModule` and `AccountHandle`

A `ProviderModule` (`src/accounts/types.ts`) is everything the app needs to know about one kind of provider:

```ts
export interface ProviderModule {
  readonly type: ProviderType;
  readonly label: string;
  /** Loads what connect() needs, so it can open its popup inside the click. */
  readonly prepare?: () => Promise<void>;
  /** Adds a new account interactively, from a user gesture. */
  connect(): Promise<{ account: Account; auth: AuthSession }>;
  /** Recreates the session of a known account without user interaction. */
  restore(account: Account): AuthSession;
  createProvider(account: Account, auth: AuthSession): MailProvider;
  readonly createCalendar?: (
    account: Account,
    auth: AuthSession,
  ) => CalendarProvider;
}

export interface AccountHandle {
  readonly account: Account;
  readonly auth: AuthSession;
  readonly provider: MailProvider;
  readonly calendar?: CalendarProvider;
}
```

A `ProviderSetup` (same file) lets the user configure a provider at runtime, such as Google's OAuth client ID in the Add account wizard; a value from the build (`.env.local`) takes precedence over one entered in the browser.

### The registry

`AccountRegistry` (`src/accounts/AccountRegistry.ts`) holds the connected accounts, one `AccountHandle` each. It is framework-agnostic; React reads it through `useSyncExternalStore` (`src/accounts/context.ts`).

- `restore()` recreates the accounts persisted in localStorage. Accounts whose module isn't registered (for example, no Google client ID yet) stay _dormant_: still persisted, not loaded.
- `registerModule(module)` adds or replaces a module at runtime (after the user entered a client ID) and wakes its dormant accounts.
- `add(type)` connects a new account through the module, from a user gesture. Re-adding a known account replaces its session.
- `addKnown(account)` adds an account whose session the module can restore without signing in (the second demo account).
- `remove(id)` forgets the account, calls `onRemove` (the composition root drops its cached data) and signs out.
- `list()`, `get(id)`, `availableModules()` and `subscribe(listener)` read it.

For each account, `handleOf` calls the module's `createProvider` and, if present, `createCalendar`.

## Gmail

| File                                                        | Contents                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/providers/gmail/GmailProvider.ts`                      | `MailProvider` for Gmail                                                    |
| `src/providers/gmail/http.ts`                               | `GmailHttp`, the HTTP client (also used for the People and Calendar APIs)   |
| `src/providers/gmail/labels.ts`                             | Labels to mailboxes, label colours                                          |
| `src/providers/gmail/mappers.ts`, `mime.ts`, `addresses.ts` | Messages to summaries and full messages, MIME tree parsing, address headers |
| `src/providers/gmail/calendar.ts`                           | `GoogleCalendarProvider` (see [Calendars](#calendars))                      |
| `src/providers/gmail/module.ts`                             | The `ProviderModule`: scopes, sign-in, wiring                               |
| `src/providers/gmail/types.ts`                              | The shapes of Google's API answers that the adapter reads                   |
| `src/providers/mime/buildMessage.ts`                        | Builds outgoing MIME messages                                               |

### Module and scopes

`createGmailModule` (`src/providers/gmail/module.ts`) asks for the full-access scope `https://mail.google.com/` (`GMAIL_SCOPE`; needed for permanent deletion), the optional contacts scopes (`CONTACTS_SCOPES`) and `gmail.settings.basic` (`SETTINGS_SCOPE`, for signatures), and the calendar scopes on demand. New accounts are asked for calendar access while connecting. A token response doesn't say whose token it is, so `connect` asks Gmail's `profile` endpoint for the address and builds the account id `gmail:<lowercased address>`. In the desktop app the module signs in natively instead (`nativeSignIn`) and asks for every scope at once, and requests go through the native `fetch`.

### HTTP client

`GmailHttp` (`src/providers/gmail/http.ts`) is a thin, typed client:

- Adds the bearer token from the `AuthSession` to every request.
- Limits concurrency per account (10 requests in flight by default), because Gmail enforces per-user quotas.
- Retries up to 3 attempts: network errors, HTTP 429, 5xx, and 403s whose reason is `rateLimitExceeded` or `userRateLimitExceeded`, with exponential backoff (500 ms doubling, plus jitter) or the `Retry-After` header. Uploads that create something (a new draft, sending) pass `retry: false` and are then not repeated after a network error or 5xx, because the first attempt may have succeeded; 429 is always repeated (it means "not processed"). `post` is only used for requests that are safe to repeat (new calendar events carry their own id for that reason).
- Translates failures: 401 calls `auth.markExpired()` and rejects as `auth-required` (`tokenRejected`), 404 as `not-found`, rate limits that ran out as `rate-limited`, no response as `network` (`unreachable`), anything else as `provider` with Google's message.
- `upload` sends a raw RFC 5322 message with JSON metadata: as one `multipart/related` request, or for messages over 5 MiB (`RESUMABLE_UPLOAD_BYTES`) as a resumable upload session. If the session URL can't be read (CORS), it falls back to the single request.

### Labels

`listMailboxes` calls `labels.list`, then `labels.get` for every label it shows (only that one returns counts), and maps them with `mapLabels` (`src/providers/gmail/labels.ts`): system mailboxes first (Inbox, Starred, Important, Sent, Drafts, All Mail, Spam, Trash), then the "Categories" group with Gmail's inbox categories, then user labels as an alphabetical tree. The mapping of each label is listed in [Mailboxes](domain-model.md#how-the-providers-map-onto-it).

- `UNREAD` and `STARRED` become the `seen` and `flagged` flags and never appear in `mailboxIds`; `CHAT` is ignored (`isMembershipLabel`).
- Gmail has no label for All Mail; the adapter invents `ALL_MAIL`, the group node `CATEGORIES`, and `synthetic:<path>` for parents that a nested name implies but that don't exist as labels. Writes reject these invented ids as `notALabel`, except that a synthetic node can be a parent when creating or moving a label.
- `hidden` follows `labelListVisibility` (`labelHide`, or `labelShowIfUnread` with no unread mail).
- Label colours must be one of the pairs Gmail's API accepts (`GMAIL_LABEL_COLORS`).

Gmail stores only label paths ("Work/Clients"). `createMailbox` builds the path from the parent's path and the leaf name (which may not contain "/"); `updateMailbox` replaces the label as a whole (`labels.update`, which is how a colour is removed) and renames every label below it when the path changes; `deleteMailbox` refuses system labels (`systemMailbox`).

### Lists and search

`listMessages` calls `messages.list` and then `messages.get` with `format=metadata` and the headers a row needs (`SUMMARY_HEADERS`) for each id; `listThreads` does the same with `threads.list` and `threads.get`. Items deleted between the list and the get are skipped rather than failing the page. The filter (`listFilter`):

- `labelIds` is the mailbox id, except for All Mail, which lists without a label (Gmail then leaves out Spam and Trash).
- `includeSpamTrash` is set only when listing Spam or Trash.
- `q` is the search text, so Gmail's search operators (`from:`, `has:attachment`, …) work. Searching everywhere is a search in All Mail.

Gmail only lists newest first. For **oldest first**, `#listOldest` lists every matching id (500 per request, ids only), reverses them and pages through that snapshot, loading the summaries of one page at a time. The cursor is `<snapshot uuid>:<offset>`; the last 5 snapshots stay in memory, and a cursor whose snapshot is gone (after a reload) lists again.

### Messages and MIME

`getMessage` and `getThread` fetch `format=full` and map it with `toMessage` (`src/providers/gmail/mappers.ts`). `parsePayload` (`src/providers/gmail/mime.ts`) walks the MIME tree:

- In `multipart/alternative`, the richest variant wins (HTML over text).
- Parts with a filename or `Content-Disposition: attachment`, and non-text leaves with a `Content-ID`, an attachment id or an image, application or message type, become attachments; inline ones keep their `contentId`.
- Text is decoded with the charset of its part; RFC 2047 encoded words in headers are decoded as a safety net.
- Gmail moves large text bodies (and calendar parts) out of the message; `#hydrateLargeTextParts` fetches them back in.
- Small parts that Gmail inlined have no attachment id; they get `part:<partId>`, which `getAttachment` resolves from the full message.

`getRawMessage` ("Show original") fetches `format=raw` and decodes the base64url bytes.

`toMessage` also reads `List-Unsubscribe` (`src/core/unsubscribe.ts`), the invitation in a `text/calendar` part (`parseInvitation`), and `Message-ID` and `References`. In list rows, `hasAttachments` is a guess (a top-level `multipart/mixed`), because the metadata format has no parts; snippets have their HTML entities decoded, and `receivedAt` comes from `internalDate`.

### Changing mail

All label changes go through `messages.batchModify` in chunks of 1000 ids; message ids never change.

| Intent                  | Gmail call                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `archive` / `unarchive` | Remove / add `INBOX`                                                                                         |
| `set-flags`             | `seen` removes or adds `UNREAD`, `flagged` adds or removes `STARRED`                                         |
| `move`                  | Add `to`; remove `from` unless it is a view (All Mail, Starred), so moving out of Starred never unstars      |
| `set-labels`            | Add and remove the labels                                                                                    |
| `trash` / `untrash`     | `messages.trash` / `messages.untrash` per message (Gmail has no batch variant), within the concurrency limit |
| `report-spam`           | Add `SPAM`, remove `INBOX`                                                                                   |
| `not-spam`              | Add `INBOX`, remove `SPAM`                                                                                   |
| `delete-forever`        | `messages.batchDelete` in chunks of 1000 (needs the full-access scope)                                       |

`emptyMailbox` accepts only Spam and Trash (`onlyTrashSpam`): it lists every id there and deletes them.

`markAllRead` lists the mailbox's unread messages (its list filter plus `is:unread`) and marks them read in chunks of 1000; it returns their ids, so Undo marks exactly those unread again. The Categories group and other synthetic mailboxes are refused.

### Drafts and sending

Outgoing mail is a raw MIME message built by `buildMessage` (`src/providers/mime/buildMessage.ts`): 7-bit clean with CRLF line endings, `multipart/alternative` (text and HTML, quoted-printable UTF-8), wrapped in `multipart/related` for inline images and `multipart/mixed` for files; headers use RFC 2047 encoded words and file names RFC 2231. Without a From header Gmail uses the account's default address. Attachments that are parts of other messages are downloaded first (`#bytesOf`).

- `saveDraft` creates a draft with `POST drafts` (not retried: a lost answer would leave a duplicate) or replaces one with `PUT drafts/{id}` (retried). The `threadId` from `DraftInput.threading` files a reply into its conversation. Each save gives the draft's message a new id.
- `sendDraft` uploads the final content and sends it in one request (`POST drafts/send`, not retried).
- `draftIdOf` pages through `drafts.list` to find the draft behind a message of the Drafts mailbox; `getDraft` turns it back into a `Draft`, including its `In-Reply-To`.

### Live updates

`changesSince` uses Gmail's history API. The token is a `historyId`; without one, the provider returns the current `historyId` from `profile`. It reads `history.list` (`messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`, 500 per page), re-reads the touched messages' summaries, and reports `added`, `updated` and `removed` (also for messages that vanished before they could be read). When the history is too old (404) or more than 100 messages changed, it returns a fresh token with `reset: true`.

### Contacts, senders and signatures

- `searchContacts` searches the People API's `people:searchContacts` and `otherContacts:search` together. Google asks for one empty search before real ones, so the first call warms up once. A 403 becomes `unavailable` with `peopleApiDisabled` (the API isn't enabled in the Google Cloud project) or `contactsDeclined`.
- `listSenders` lists the send-as addresses (`settings/sendAs`) that are primary or verified, the default first, with their signatures as Gmail stores them.
- `updateSignature` patches `settings/sendAs/{address}`; a 403 (the optional settings scope was declined) becomes `unavailable` with `settingsNotAllowed`.
- `oneClickUnsubscribe` is shared with Graph (`src/providers/oneClickUnsubscribe.ts`): an RFC 8058 POST with no cookies and no referrer, sent `no-cors`, so only "reached" or "unreachable" can be told apart.

## Microsoft Graph

| File                                                                                  | Contents                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/providers/microsoft/GraphProvider.ts`                                            | `MailProvider` for Exchange Online and Outlook.com            |
| `src/providers/microsoft/http.ts`                                                     | `GraphHttp`, with `$batch` and upload chunks                  |
| `src/providers/microsoft/folders.ts`                                                  | Folders, views and categories to mailboxes                    |
| `src/providers/microsoft/mappers.ts`                                                  | Messages, recipients, attachments, invitations                |
| `src/providers/microsoft/calendar.ts`, `recurrence.ts`, `zones.ts`, `windowsZones.ts` | `GraphCalendarProvider` (see [Calendars](#calendars))         |
| `src/providers/microsoft/module.ts`                                                   | The `ProviderModule`: MSAL sign-in, personal accounts, wiring |
| `src/providers/microsoft/types.ts`                                                    | The shapes of Graph's answers that the adapter reads          |

### Module

`createMicrosoftModule` signs in with an MSAL popup (`acquireTokenPopup`) for `GRAPH_SCOPES` (`Mail.ReadWrite`, `Mail.Send`, `People.Read`, `User.Read`, `MailboxSettings.ReadWrite`, `offline_access`; `src/auth/microsoft/msal.ts`) and asks for consent to `Calendars.ReadWrite` in the same popup. The account id is `microsoft:<lowercased sign-in name>`. Personal accounts (the personal tenant id, or an outlook/hotmail/live/msn address) get the lower attachment limit. Signatures are stored in localStorage under `a0.settings.signatures.<accountId>`, because Graph can't read or write Outlook's.

### HTTP client

`GraphHttp` (`src/providers/microsoft/http.ts`):

- Adds the bearer token and `Prefer: IdType="ImmutableId"` to every request (batched ones included), so message ids survive moves between folders and a sent draft keeps its id in Sent Items. Extra preferences (such as `outlook.timezone="UTC"` or `odata.maxpagesize`) are appended to the same header.
- Limits concurrency to 4 requests in flight, because Outlook throttles per mailbox.
- Retries up to 3 attempts: 429 always, 503 and 504 unless the request creates something (`retry: false`), honouring `Retry-After`, otherwise with exponential backoff.
- `batch(requests)` runs requests through `$batch`, 20 per call (`BATCH_LIMIT`). Throttled requests inside a batch are repeated after their `Retry-After`; other failures come back as results, not exceptions, so callers decide what a partial failure means (`bodiesOrThrow` in the provider throws the first).
- `get` also takes a full URL (an `@odata.nextLink` used as a cursor) and rejects anything that isn't below `https://graph.microsoft.com/v1.0/`.
- `putChunk` uploads a piece of an upload session to Microsoft's pre-authorized URL, without a token.
- Failures become `MailError`s like Gmail's (401 marks the session expired); `graphErrorCode(error)` reads Graph's own code (`ErrorItemNotFound`, …) from the cause.

### Folders, views and categories

The provider resolves Outlook's well-known folder names once, in one batch (`#wellKnownFolders`): the role folders (`inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`, `archive`), the internal ones (`outbox`, `conversationhistory`, `syncissues`, `scheduled`, `searchfolders`) and the root `msgfolderroot`. A missing folder (an account without Archive) is fine.

`listMailboxes` loads the folder tree level by level, the children of every folder with children in one `$batch`, and maps it with `mapFolders` (`src/providers/microsoft/folders.ts`):

- Role folders come first, then the views, then the user's folders. Internal folders and everything inside them are left out. Role folders and the root's children are top-level (no `parentId`); other folders keep their parent.
- Every folder is `kind: "folder"` with counts from `unreadItemCount` and `totalItemCount`; Drafts and Sent Items are not assignable.
- Two views are added: **Flagged** (`view:flagged`, role `flagged`) and **All mail** (`view:all`, role `all`, hidden; it exists so search can cover the whole account).
- Categories (`me/outlook/masterCategories`) become labels `view:category:<name>` under a `view:categories` group, sorted by name and coloured from Outlook's 25 presets (`preset0` … `preset24`). Their unread counts come from one `$count` query per category (with `ConsistencyLevel: eventual`); their total is reported as 0. While the account lacks the permission for the category list (403), there are none.

`toMessageSummary` (`src/providers/microsoft/mappers.ts`) puts the message's `parentFolderId` first in `mailboxIds`, then its categories as `view:category:<name>`.

`getRawMessage` ("Show original") reads `me/messages/{id}/$value`, the MIME content as Exchange keeps it (in the desktop app through the native side, like every request).

### Lists, views and search

- A folder lists `me/mailFolders/{id}/messages` ordered by `receivedDateTime`, either way; the cursor is Graph's `@odata.nextLink`.
- A view lists `me/messages`, filtered on the server where Graph can (`flag/flagStatus eq 'flagged'`, `categories/any(…)`; Graph wants the `$orderby` property in `$filter` too, and first) and on the client by `#viewFilter`: no Deleted Items, Junk Email or internal folders, only flagged mail for Flagged, only the category's mail for a category. Because of that filter, one call for a view reads up to 5 pages until it has something to show.
- Search uses `$search` with the quoted text, in the folder or (for views) in `me/messages`. Oldest-first search collects up to 1000 matches, sorts them by date and pages through a snapshot. Snapshot cursors are `snapshot:<key>:<offset>`; the last 5 stay in memory, and a cursor whose snapshot is gone collects again.

### Conversations

A conversation is Outlook's own: the message's `conversationId` is its `ThreadId`. Graph can't list conversations, so `listThreads` (newest first) walks the mailbox's messages page by page, loads the whole conversation of each message on the page in one `$batch` (`conversationId eq '…'`, up to 100 messages each, from every folder), and shows a conversation on the page that holds its newest message in that mailbox, so it appears exactly once. Search and oldest first collect and sort the conversation ids first (at most 1000 search matches, or 20,000 messages of the mailbox) and page through a snapshot. `getThread` loads all messages of a conversation with bodies and their attachments' metadata. A message without a conversation id is a conversation of its own.

### Changing mail

Moves go through `POST me/messages/{id}/move` in `$batch` requests; with immutable ids the message keeps its id.

| Intent                             | Graph call                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archive`                          | Move to `archive` (no Archive folder: `noArchiveFolder`)                                                                                              |
| `unarchive`, `untrash`, `not-spam` | Move to `inbox` (Graph doesn't say where a message was before; undo of a trash or spam moves back to the original folder through `inverseOf` instead) |
| `set-flags`                        | `PATCH` `isRead` and `flag.flagStatus`, batched                                                                                                       |
| `move`                             | Move to `to`; a view as target is refused (`notAFolder`)                                                                                              |
| `set-labels`                       | Categories only (`notACategory` otherwise): read each message's categories, then `PATCH` the whole list                                               |
| `trash`                            | Move to `deleteditems`                                                                                                                                |
| `report-spam`                      | Move to `junkemail`                                                                                                                                   |
| `delete-forever`                   | `DELETE me/messages/{id}`, batched; like Outlook's Shift+Delete, Outlook can still recover them for a while                                           |

`emptyMailbox` accepts only Deleted Items and Junk Email and deletes their messages 200 at a time.

`markAllRead` lists the unread messages (`isRead eq false`) of the folder, or of a view by its filter (Flagged, a category), then sets `isRead` on them like `setFlags`, and returns their ids for Undo. The Categories group itself is refused.

### Folder and category management

- `createMailbox` creates a folder (in the root or a parent folder) or, with `kind: "label"`, a category with an Outlook colour. Name clashes become `folderExists` or `categoryExists`.
- `updateMailbox` renames (`PATCH displayName`) and moves (`POST …/move`) folders; moving a folder into itself is `folderInsideItself`. For a category it only changes the colour: renaming is `categoryRename`, since Outlook can't.
- `deleteMailbox` moves a folder with its mail to Deleted Items, like Outlook, and deletes it for good only when it is already there. A deleted category leaves the list; mail keeps the name. Well-known folders can't be changed (`systemMailbox`).

### Drafts and upload sessions

A Graph draft is a message: `DraftId` and the draft's `MessageId` are the same immutable id, and sending keeps it.

- `saveDraft` creates a new draft with `POST me/messages`, or, when `threading.inReplyTo` names a message in the mailbox (found by `internetMessageId`), with `createReply` on it (or `createForward` when `threading.forward` is set, so Outlook records a forward, not a reply), so the conversation and threading headers are Outlook's; the content is then replaced. A forward reuses the attachments Outlook copies from the original (matched by name and size) instead of uploading them again. Existing drafts are updated with `PATCH`. The fields are subject, HTML body and recipients; there is no From field (Graph can't list send-as addresses).
- `#syncAttachments` then makes the draft's attachments match: it deletes the ones no longer wanted and uploads the missing ones. Files up to 3 MiB go up in one request as base64 (`SMALL_ATTACHMENT_BYTES`); bigger ones through an upload session in chunks of 3.75 MiB (`UPLOAD_CHUNK_BYTES`, a multiple of 320 KiB as Graph requires). The provider remembers which local attachment became which server attachment, so later saves don't upload them again; upload sessions don't return the new id, so it is matched by name. A network failure at the first chunk means the upload server can't be reached from here (`attachmentUploadBlocked`: files of up to 3 MB still work); one at a later chunk means the connection dropped (`attachmentUploadInterrupted`), and the draft's next save tries again.
- `sendDraft` saves the final content and posts `…/send` (not retried).
- `getDraft` turns a draft back into a `Draft`; a plain-text body becomes HTML.

### Live updates

`changesSince` follows every folder with Graph's delta queries. The token is the provider's own JSON (still opaque to callers): the start of the last poll, one delta link per tracked folder, and a delta link for the folder tree. Each folder's delta covers mail received in the last 30 days (`DELTA_WINDOW_DAYS`).

One poll sends all delta links in one `$batch`. New or deleted folders in the tree (or a folder whose delta link is gone: 404 or 410) make the provider re-list the folders, start tracking new ones and drop vanished ones. The touched messages are re-read in a batch; a message counts as `added` if it was created after the previous poll started, and as `removed` if it can't be found any more. More than 100 changes, or a token it can't read, give a fresh token with `reset: true`.

### Contacts, senders and invitations

- `searchContacts` searches `me/people` (people you correspond with); a 403 or 400 becomes `unavailable` (`peopleUnavailable`).
- `listSenders` returns only the account's own address, with the signature stored in this browser; `updateSignature` writes it there (`capabilities.signatureStore` is `browser`).
- Outlook's invitations, cancellations and answers are event messages: `getMessage` reads the event's `iCalUId` and maps `meetingMessageType` to the invitation's `method` (`toInvitation`). A failed lookup just leaves the invitation out.

## Calendars

Each account module creates a calendar provider next to the mail provider (`createCalendar`); iCal subscriptions get one each through the `IcsFactory` (`src/data/calendar.ts`, wired in `src/app/services.ts` and, with the native `fetch`, in `src/main.tsx`). The data layer treats both as calendar _sources_, keyed by the account id or `ics:<subscription id>`.

|                | Google (`GoogleCalendarProvider`) | Microsoft (`GraphCalendarProvider`)       | iCal (`IcsCalendarProvider`) |
| -------------- | --------------------------------- | ----------------------------------------- | ---------------------------- |
| `canRespond`   | yes                               | yes                                       | no                           |
| `canEdit`      | yes                               | yes                                       | no (read-only)               |
| `guestNotices` | `ask`                             | `always`                                  | `always`                     |
| `maxReminders` | 5                                 | 1                                         | 0                            |
| `reminderSync` | none (marks kept in this browser) | Outlook's reminder list                   | none                         |
| Access         | Optional scopes, asked on demand  | Optional consent to `Calendars.ReadWrite` | Always granted               |

### Google Calendar

`src/providers/gmail/calendar.ts` uses the Calendar API v3 through a `GmailHttp` with its own base URL, so it shares retries and error handling with Gmail. Access needs `CALENDAR_SCOPES` (`calendar.calendarlist.readonly` and `calendar.events`); without them, calls reject as `unavailable` with `calendarAccessNeeded`, and `requestAccess()` asks for them through the session's `requestScopes`.

- **Calendars:** `calendarList` entries the user can at least read. A calendar is shown by default if it is the primary one or selected in Google Calendar, read-only for the `reader` role, and offers Google Meet if its conference properties allow it.
- **Events:** `events.list` with `singleEvents=true`, so Google expands repeating events; cancelled ones are left out. Event ids are unique per calendar only, so the adapter's `EventId` is `<encoded calendar id>/<event id>`. Descriptions are HTML, the meeting link comes from the conference data or `hangoutLink`.
- **Reminders:** only on-screen (`popup`) ones count. An event that uses the calendar's defaults gets the defaults from the event list's answer. Writing reminders keeps the event's email reminders.
- **Writes** carry `sendUpdates=all` or `none` (from `WriteOptions.notify`) and `conferenceDataVersion=1`. New events get an id chosen by the client, so a repeated request can't create two (a 409 means an earlier attempt worked). Series are changed through their master event with RRULE lines (`src/core/recurrence.ts`); "this and following" ends the old series and inserts a new one, counting earlier occurrences (`instances`) when the rule has a `COUNT`.
- **Undo:** changes patch the old values back. A deleted event is restored by setting its status back to `confirmed` (Google keeps deleted events as cancelled for a while), or recreated as a copy if that fails.
- **Answers:** `respond` sets your attendee status with `sendUpdates=all`. `findInvitation` searches the primary calendar by `iCalUID`.

### Microsoft Graph calendars

`src/providers/microsoft/calendar.ts` uses a `GraphHttp` whose tokens come from `session.tokenFor(CALENDAR_SCOPES)` (`src/providers/microsoft/module.ts`).

- **Time zones:** events are read with `Prefer: outlook.timezone="UTC"` and converted to instants; all-day events become dates. Graph names zones the Windows way, so `zones.ts` translates: `ianaZone` maps Graph's `originalStartTimeZone` to IANA, `windowsZone` maps an IANA zone to the Windows name Graph accepts (zones CLDR doesn't list get the Windows zone with the same offsets all year, else "UTC"), and `usableZone` falls back to the browser's zone. The table comes from CLDR's `windowsZones.xml` (`windowsZones.ts`, Unicode License) and is loaded on first use (`loadZones`), outside the main bundle. Writes send the wall-clock time and the Windows zone name.
- **Calendars:** `me/calendars`; every calendar is shown by default, read-only when `canEdit` is false, and offers Teams when `teamsForBusiness` is allowed. New events default to a 15-minute reminder.
- **Events:** `calendarView` per calendar, which expands series. Cancelled events are left out.
- **Recurrence:** Graph's `patternedRecurrence` has its own converters (`src/providers/microsoft/recurrence.ts`: `repeatOfGraph`, `graphRecurrence`, `retimeGraph`, `splitGraph`), used the same way as the RRULE ones.
- **Writes:** new events carry a `transactionId`, so Graph ignores a repeated request. Teams meetings (`isOnlineMeeting`) can't be taken off again (`videoCallFixed`), and Outlook's join text in their description stays out of the editor (`splitMeetingText`). Graph always notifies guests. Deleted events can't be brought back, so undo creates a copy (an occurrence comes back as an event of its own).
- **Reminders:** one per event (`isReminderOn`, `reminderMinutesBeforeStart`). `reminderSync` lists due reminders from `reminderView` and dismisses and snoozes through `dismissReminder` and `snoozeReminder`, so the state is shared with Outlook on every device.
- **Answers:** `respond` posts `accept`, `tentativelyAccept` or `decline` with `sendResponse: true`. `findInvitation` searches `me/events` by `iCalUId`.

### iCal subscriptions

`IcsCalendarProvider` (`src/providers/ical/IcsCalendarProvider.ts`) reads one subscription (`IcsSubscription`: id, URL, name, colour, kept in the settings in localStorage):

- `icsUrl` turns `webcal://` into `https://`. The file is fetched without cookies, referrer or HTTP cache (the address itself is the secret), and one download is shared for a minute.
- In the web app the browser can only read servers that allow it (CORS). No answer at all becomes `icsBlocked`, an HTTP error `icsNotFound`, a file without `BEGIN:VCALENDAR` `icsUnreadable`, an address that isn't one `icsBadUrl`. The desktop app passes its native `fetch`, which has no CORS limits.
- [ical.js](https://github.com/kewisch/ical.js) is loaded on first use. The provider registers the file's `VTIMEZONE`s and expands repeating events itself (at most 5000 occurrences per series in a range). Each occurrence's id is `<UID>/<start>`.
- Reminders come from `VALARM`s with `DISPLAY` or `AUDIO` actions, relative to the start or end, or at a fixed time.
- It is read-only: every change rejects with `readOnlyError()` (`calendarReadOnly`), and `respond` rejects too.

## Fake provider and demo data

`src/providers/fake/` holds in-memory providers that follow the same rules as the real ones: views are computed, counts are derived from the messages, results are sorted by date, and writes change what later reads return. Tests use them through `renderApp()` (`src/test/renderApp.tsx`), and the demo accounts are built from them.

### `FakeMailProvider`

`FakeMailProvider` (`src/providers/fake/FakeMailProvider.ts`) takes `FakeMailData`: mailboxes, messages, attachment bytes, the account's own address (`me`), contacts, label colours, senders, and `folders`, which switches between two modes:

| Mode                     | Capabilities                                                                                        | Behaviour                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label (default)          | `mailboxKinds: ["label", "view"]`; labels can be renamed, coloured, nested and hidden               | Like Gmail: archive removes the Inbox, move adds `to` and removes `from` unless it is a view, trash adds Trash and keeps the other labels                       |
| Folder (`folders: true`) | `["folder", "label", "view"]`; folders can be renamed and nested, labels (categories) only coloured | Like Outlook: archive, trash, spam and move put the message into exactly one folder, untrash and not-spam into the Inbox; deleting a folder moves it into Trash |

Like Gmail, messages in Spam or Trash show up only there. Search matches plain words (case- and accent-insensitive) in subject, sender, recipients and snippet; there are no operators. Cursors are offsets, and `changesSince` reads a change log with a version number as its token.

Options and switches for tests: `latencyMs` (simulated network delay), `failWrites` (every write fails, to exercise rollback), `contactsUnavailable`, `signaturesReadOnly`, `oneClickRequests` (the unsubscribe URLs it "sent"), and `arrivals`, which lets a new message "arrive" every so often; the arrival is checked inside `changesSince`, so no timers run in the provider.

### `FakeCalendarProvider`

`FakeCalendarProvider` (`src/providers/fake/FakeCalendarProvider.ts`) builds events from templates placed relative to "now" (weekdays of a repeating event, or a day offset from this week's Monday). It supports answers, editing with series scopes and undo. Options: `access` (start as `missing` to test "Allow calendar"), `guestNotices` (`ask` like Google or `always` like Microsoft), `syncedReminders` (one reminder per event with an Outlook-like `reminderSync`; otherwise up to 5). Tests can set `failWrites` and read every write from `writes`.

### Demo accounts

`createDemoModule` (`src/providers/fake/module.ts`) is the `demo` provider module. It needs no sign-in (`StaticAuthSession`) and simulates 150 ms of latency. It has two accounts:

| Account                  | Data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo:demo@example.com`  | Gmail-like (`createDemoData` in `demoData.ts`): about 200 messages with timestamps relative to now, made reproducible by a seeded random generator; labels, inbox categories, two send-as addresses with signatures, contacts, attachments (a PDF, pictures), newsletters that offer unsubscribing, and an invitation mail. A new message arrives every 2 minutes (`createDemoArrival`). Its calendar (`demoCalendar.ts`) has Work, Personal and Holidays calendars and the event the invitation mail is about (`DEMO_INVITATION_UID`). |
| `demo:demo@work.example` | Outlook-like (`createWorkDemoData` in `demoWork.ts`): about 40 messages in folders (`folders: true`), with categories in Outlook's colours, timed between the first account's so All inboxes mixes them. Mail arrives every 3 minutes (`createWorkArrival`). Its calendar is empty.                                                                                                                                                                                                                                                     |

Opening the app with `/?demo` adds the first account through `registry.add("demo")` and the second through `registry.addKnown` (`src/main.tsx`). Tests replace the data, clock, calendar and arrival interval through `DemoModuleOptions`.

## Adding a provider

The checklist below is written with IMAP in mind, which the roadmap plans for the desktop app (see [decisions.md](decisions.md)), but it applies to any provider. Follow the way of working in [CLAUDE.md](../CLAUDE.md#how-we-work-mandatory): plan, outline, implement, test, one feature at a time.

1. **Provider type.** Add the type to `ProviderType` (`src/core/model.ts`) and to `PROVIDER_TYPES` in `src/accounts/accountStorage.ts`; otherwise saved accounts of that type are dropped when the list is loaded.
2. **Capabilities.** Decide `capabilities` honestly (see [Capabilities](domain-model.md#capabilities)). An IMAP account is a folder account: `mailboxKinds` with `folder` (and `view` if you add computed views), and `mailboxEditing.folder` for what folder management allows. Set `threads` only if conversations can be listed; set `contacts`, `senders` and `signatureStore` to match what the server offers. Turn off what you can't do: the UI hides it.
3. **Mailboxes.** Map the server's mailboxes to `Mailbox` with the right `kind`, `role` (IMAP SPECIAL-USE flags map directly), `selectable` (`\Noselect` is `false`), `hidden`, `assignable` (`false` for Sent and Drafts) and `counts`. Return them in display order.
4. **IDs and cursors.** Choose id formats that are opaque to everyone else, and keep invented ids recognisable to the provider itself (Graph prefixes its views with `view:`). Message ids must stay the same when a message moves or changes labels: the data layer, selections, undo steps and URLs rely on it. IMAP UIDs are per folder, so an IMAP adapter has to give messages stable ids itself, with RFC 8474's `EMAILID` where the server supports it, or with its own mapping. Cursors can be offsets or snapshot keys, as long as they come back unchanged.
5. **Implement `MailProvider`.** Every method, with `MailError`s (codes and, where the app describes the cause, a `reason`) and `AbortSignal` support. Make the write methods do what `planChanges` predicts for the account's kinds (`src/data/optimistic.ts`): for a folder account, archive, trash and spam move into the folder with that role, and messages in Trash or Spam must not show up in other lists. Retries and concurrency limits belong in the provider's HTTP client, not the query client. Keep message bodies raw: they are sanitized when the reader shows them (`src/security/`). Reuse what's shared: `buildMessage` (`src/providers/mime/buildMessage.ts`) builds raw MIME for sending, `parseAddressList` (`src/core/addresses.ts`) parses address headers, `parseListUnsubscribe` and `parseInvitation` read headers and calendar parts, and `sendOneClickUnsubscribe` sends RFC 8058 requests.
6. **Live updates.** Implement `changesSince` with an opaque token (for IMAP, for example per-folder `UIDVALIDITY`/`MODSEQ` state serialized like Graph's delta links) and return `reset: true` when the changes are too many or the token is unusable.
7. **Calendar (optional).** Implement `CalendarProvider` and return it from the module's `createCalendar`. A read-only source can follow `IcsCalendarProvider`.
8. **Auth session.** Implement `AuthSession` (and `ScopedSession` for permissions asked on demand), or reuse one. `getAccessToken` never opens UI; the HTTP layer calls `markExpired()` when the server rejects the credentials. Credentials follow [security.md](security.md): never in localStorage, and in the desktop app long-lived secrets only on the native side.
9. **Provider module.** Write a `ProviderModule` in `src/providers/<name>/module.ts`: `type`, `label`, `prepare` (load what `connect` needs before the click), `connect` (interactive, builds the `Account` with the id `<type>:<lowercased address>`), `restore`, `createProvider`, `createCalendar`. Accept an optional `fetch`, as the Gmail and Microsoft modules do, so the desktop app can route requests through its native side.
10. **Wiring.** Register the module in `createDefaultModules` in `src/app/services.ts` (for the web app, the desktop app or both); if the provider needs configuration entered at runtime, add a `ProviderSetup` in `createDefaultSetups`. Browsers can't open TCP connections, so an IMAP provider needs a transport on the desktop app's native side (`src-tauri/`, exposed to the UI through `src/platform/native`); plan that with the feature.
11. **Add account wizard.** The card list is `ACCOUNT_TYPE_CARDS` in `src/ui/accounts/accountTypes.ts` (IMAP already has a greyed-out `comingLater` card), with texts in `src/i18n/texts/accounts.ts`. `src/ui/accounts/AddAccountFlow.tsx` assumes every non-demo type is set up with an OAuth client and signed in with a popup; a provider with another setup (server, user name, password) needs its own steps there.
12. **Errors and texts.** Add new causes to `MailErrorReason` (`src/core/errors.ts`) and describe them in English and German in `src/i18n/texts/errors.ts` (the typecheck fails otherwise). All other interface text goes into the catalogue too; see [development.md](development.md).
13. **Tests.** Test the adapter in the Node environment (`// @vitest-environment node`) against a mock server with [MSW](https://mswjs.io/) and `server.listen({ onUnhandledFrame: "error" })`, so an unexpected request fails the test, as `GmailProvider.test.ts` and `GraphProvider.test.ts` do. A stateful fake server like `FakeGraph` (`src/test/graphServer.ts`) keeps tests of writes, drafts and delta sync readable. Never call real servers. Check that the provider's writes and `planChanges` agree. UI behaviour that depends on the provider's model can be tested with `FakeMailProvider` (folder mode is Outlook-like). See [testing.md](testing.md).
14. **Docs.** Describe the adapter here, add setup steps to the README, and record the decisions in the decisions log in `CLAUDE.md`.
