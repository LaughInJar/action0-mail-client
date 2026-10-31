# Domain model

The domain model is the provider-agnostic vocabulary that the interface, the data layer and every provider share. It lives in `src/core` and has no dependencies: identifiers, mailboxes, messages and conversations, the write operations (_intents_), what a provider can do (_capabilities_), outgoing mail, calendars and errors. The mailbox model follows [JMAP (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621), so Gmail's labels and the folders of Exchange (and later IMAP) fit the same types without provider branches in the UI. All values are plain, JSON-serializable data, so the cache can persist them unchanged (`src/core/model.ts`).

- [Accounts and IDs](#accounts-and-ids)
- [Mailboxes](#mailboxes)
- [Messages, flags and conversations](#messages-flags-and-conversations)
- [Intents](#intents)
- [Capabilities](#capabilities)
- [Compose model](#compose-model)
- [Calendar model](#calendar-model)
- [Errors](#errors)

How these types travel through the app is described in [architecture.md](architecture.md); how Gmail, Microsoft Graph, iCal and the fake provider map onto them is in [providers.md](providers.md). The reasons behind the model are in [decisions.md](decisions.md).

## Accounts and IDs

An `Account` (`src/core/model.ts`) is a connected account without credentials: its `id`, its `type` (`ProviderType`: `"gmail" | "microsoft" | "demo"`) and its primary `email`, which is also the login hint when the account signs in again. The account list in localStorage holds exactly these three fields (`src/accounts/accountStorage.ts`).

### Branded, opaque IDs

Every identifier is a branded string (`Brand<T, B>` in `src/core/ids.ts`), so the compiler keeps a `MessageId` apart from a `MailboxId` even though both are strings at run time. Each has an `as…` helper that brands a raw string: providers use them when they map API answers, and the router and the mailbox tree when they read ids back from the URL or the DOM (`src/state/router.ts`, `src/ui/mailboxes/`).

| Type                    | Identifies                                               | Notes                                                                                     |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AccountId`             | An account across all providers                          | Built by the provider module, e.g. `gmail:jane@example.com`                               |
| `MailboxId`             | A label, folder or view of one account                   | Opaque                                                                                    |
| `MessageId`             | A message of one account                                 | Opaque; stays the same when the message moves or changes labels (see below)               |
| `ThreadId`              | A conversation of one account                            | Opaque                                                                                    |
| `AttachmentId`          | An attachment or inline part of a message                | Opaque                                                                                    |
| `DraftId`               | A draft of one account                                   | Opaque; may differ from the id of the draft's message (Gmail gives it a new one per save) |
| `SyncToken`             | A position in an account's change history                | Opaque (Gmail `historyId`, Graph delta links)                                             |
| `Cursor`                | A page position in a list                                | Opaque (Gmail `pageToken`, Graph `@odata.nextLink`); passed back unchanged                |
| `CalendarId`, `EventId` | A calendar, an event occurrence (`src/core/calendar.ts`) | Opaque within their source                                                                |

_Opaque_ means only the provider that issued an id may look inside it. The UI and the data layer store, compare and pass ids back, but never parse them. Providers are free to put structure into them; [providers.md](providers.md) lists what each one does (for example Graph's `view:flagged` or Gmail's `<snapshot>:<offset>` cursors).

Account ids have a fixed shape, though nothing parses them either: modules build them as `<type>:<lowercased email>` (`src/providers/gmail/module.ts`, `src/providers/microsoft/module.ts`, and the desktop app's vault keys in `src-tauri/src/oauth/mod.rs`). The demo accounts are `demo:demo@example.com` and `demo:demo@work.example` (`src/providers/fake/module.ts`). Query keys start with `["acct", accountId]` (`src/data/keys.ts`), so removing an account drops all of its cached data in one call (`src/app/services.ts`).

Message ids stay the same across writes: Gmail's never change, Graph is asked for immutable ids, and IMAP, whose UIDs change when a message moves, uses the server's `EMAILID` (RFC 8474) or `X-GM-MSGID` where it has them and otherwise a location id the native side keeps following ([imap.md](imap.md#the-mail-model)). So `MutationResult` (`src/core/provider.ts`) carries nothing, and the data layer never re-keys caches, selections or URLs.

### Message keys

Message ids are only unique within an account, but All inboxes lists the Inboxes of several accounts in one list. Wherever a message has to be identified across accounts, the app uses a `MessageKey`:

```ts
export const messageKey = (
  accountId: AccountId,
  messageId: MessageId,
): MessageKey => JSON.stringify([accountId, messageId]) as MessageKey;

export interface MessageRef {
  readonly accountId: AccountId;
  readonly messageId: MessageId;
}

export function messageRef(key: MessageKey): MessageRef;
```

`messageKey` is the only place that builds a key and `messageRef` the only place that reads one back; the ids inside stay opaque. List rows, focus and selection are keyed by `MessageKey` (`src/data/listRows.ts`, `src/state/uiStore.ts`), and actions on a selection group the keys by account before they run (`src/ui/actions/useMailActions.ts`). The URL keeps account and message apart instead, as separate hash segments: `#/<accountId>/<mailboxId>[/<messageId>]`, each URI-encoded (`src/state/router.ts`).

## Mailboxes

A `Mailbox` (`src/core/model.ts`) is anything a message can be in. A message has a _set_ of mailbox ids (`MessageSummary.mailboxIds`), and each mailbox says what kind of membership it is:

| `kind`   | Membership                                   | Examples                                                   |
| -------- | -------------------------------------------- | ---------------------------------------------------------- |
| `label`  | Non-exclusive: a message can have any number | Gmail labels, Gmail's inbox categories, Outlook categories |
| `folder` | Exclusive: a message is in exactly one       | Outlook folders (later IMAP folders)                       |
| `view`   | Computed by a query; never a drop target     | Gmail All Mail and Starred, Outlook Flagged and All mail   |

The other fields:

| Field        | Meaning                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | Leaf name ("Clients" for the Gmail label "Work/Clients"). Interface names of roles and standard mailboxes come from the translations instead (`mailboxName` in `src/ui/common/mailboxNames.ts`).                                 |
| `parentId`   | Nesting in the tree; absent at the top level.                                                                                                                                                                                    |
| `role`       | Special purpose, from the JMAP / IMAP SPECIAL-USE (RFC 6154) vocabulary: `inbox`, `flagged`, `important`, `sent`, `drafts`, `all`, `archive`, `junk`, `trash`. `MAILBOX_ROLE_ORDER` sorts siblings in the tree.                  |
| `standard`   | A well-known mailbox without a role, named by the interface: `categories`, `primary`, `social`, `promotions`, `updates`, `forums`.                                                                                               |
| `selectable` | `false` for grouping nodes that hold no messages themselves: Gmail's "Categories" group and the parents Gmail implies by a path like "Work/Clients" when no "Work" label exists, Outlook's "Categories" group, IMAP `\Noselect`. |
| `hidden`     | The user asked the provider to hide it from the folder list. The tree leaves it and everything below it out (`src/ui/mailboxes/buildTree.ts`); Manage labels still lists it.                                                     |
| `assignable` | Users may put messages in and take them out: a target for moving and labelling. `false` for views and for system mailboxes that fill themselves (Sent, Drafts).                                                                  |
| `counts`     | `{ unread, total }`, if the provider reports them.                                                                                                                                                                               |
| `color`      | `{ background, text }` CSS colours of a label chip.                                                                                                                                                                              |

Rules built on these fields (`src/data/mailboxActions.ts`, `src/ui/pickers/MailboxPicker.tsx`):

- **The user's own mailboxes** are selectable, assignable, without a role and not views (`isOwnMailbox`). Only they can be renamed, recoloured, moved, hidden or deleted, as far as the provider allows (see [Capabilities](#capabilities)).
- **Move and label targets** are mailboxes that are both assignable and selectable.
- **Nesting targets** are the user's own mailboxes, implied grouping nodes, and in folder accounts Inbox and Archive (Outlook keeps folders in them) (`isNestable`).
- **Folder wording:** an account with folders is treated as an Outlook-style account: roles get Outlook's names ("Deleted Items", "Junk Email") when its mailboxes include a `folder` (`src/ui/common/mailboxNames.ts`), and the label dialogs speak of folders when its `capabilities.mailboxKinds` include `folder` (`src/ui/labels/mailboxTexts.ts`).

### How the providers map onto it

| Provider concept                                     | Mailbox                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Gmail `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`      | `label` with the matching role. Inbox, Spam and Trash are assignable; Sent and Drafts are not.             |
| Gmail `STARRED`                                      | `view` with role `flagged` (starring is a flag, see below)                                                 |
| Gmail `IMPORTANT`                                    | `label` with role `important`, not assignable (Gmail decides importance)                                   |
| Gmail All Mail (no label exists for it)              | `view` with role `all` and the invented id `ALL_MAIL`                                                      |
| Gmail `CATEGORY_*`                                   | `label` with a `standard` name, not assignable, under a non-selectable "Categories" group                  |
| Gmail user label "Work/Clients"                      | `label` "Clients", parent "Work" (a non-selectable `synthetic:Work` node if no such label exists)          |
| Outlook well-known folders (`inbox`, `sentitems`, …) | `folder` with the matching role; Drafts and Sent Items are not assignable                                  |
| Outlook user folders                                 | `folder`, nested as in Outlook                                                                             |
| Outlook flagged mail                                 | `view` `view:flagged` with role `flagged`                                                                  |
| Outlook "everything"                                 | `view` `view:all` with role `all`, hidden (it exists so search can cover the whole account)                |
| Outlook category "Team"                              | `label` `view:category:Team` under a non-selectable "Categories" group, coloured from Outlook's 25 presets |

Outlook categories are listed by name because Outlook can't rename a category, so the name is stable. Graph's internal folders (Outbox, Conversation History, Sync Issues, …) and everything below them are left out. Details are in [providers.md](providers.md).

## Messages, flags and conversations

`src/core/model.ts` has three levels of message data:

- **`MessageSummary`**: what a list row needs. `id`, `threadId?`, `mailboxIds`, `from?`, `to`, `subject`, `snippet` (plain text), `receivedAt` (ISO 8601), `flags` and `hasAttachments` (which may be a guess in lists; Gmail's list format has no parts).
- **`Message`**: a summary plus `cc`, `bcc`, `replyTo`, `internetMessageId` (the `Message-ID` with angle brackets), `references` (oldest first), `unsubscribe?` (from `List-Unsubscribe`, parsed in `src/core/unsubscribe.ts`), `invitation?` (see [Calendar model](#calendar-model)), `body` (`html?` and `text?`, raw and **unsanitized**) and `attachments` (`AttachmentInfo`; inline parts carry the `contentId` the HTML references as `cid:`).
- **`ThreadSummary`** and **`Thread`**: a conversation with all its messages, in every mailbox (Trash and Spam included), oldest first; as summaries for list rows, as full messages for the reader.

`mailboxIds` holds one folder for folder providers (Graph adds the message's categories after it: the folder first, so undo can find it) and any number of labels for label providers. It never holds flag-like labels such as Gmail's `UNREAD` or `STARRED`.

### Flags

Read/unread and starred are `MessageFlags`, not mailboxes:

```ts
export interface MessageFlags {
  readonly seen: boolean;
  readonly flagged: boolean;
}
```

Gmail stores them as the `UNREAD` and `STARRED` labels, Outlook as `isRead` and the follow-up flag; the providers translate both ways. Mailboxes with role `flagged` (Gmail Starred, Outlook Flagged) are views over `flagged`.

### One row per message, or per conversation

The list shows one row per message by default. The conversation switch in Settings → Reading makes it one row per conversation, for accounts whose provider has `capabilities.threads` (`src/data/hooks.ts`); the data layer then calls `listThreads` instead of `listMessages`. Both end up as `ListRow`s (`src/data/listRows.ts`):

```ts
export interface ListRow {
  readonly key: MessageKey;
  readonly accountId: AccountId;
  readonly id: MessageId;
  /** The message, or a conversation's newest message shown in this list. */
  readonly summary: MessageSummary;
  readonly thread?: ThreadSummary;
}
```

A conversation row is keyed and routed by its _oldest_ message, which stays the same while replies come in. Its `summary` is the newest message that is visible in the current mailbox. `threadIdOf` (`src/data/optimistic.ts`) treats a message without a `threadId` as a conversation of its own.

Actions on a conversation row cover its messages. Actions with `exact` (the context menu of one message inside an open conversation) cover only the messages named, and their toasts count messages, not conversations.

### Trash and Spam isolate

Like Gmail, messages in Trash or Spam show up only there, even if they still carry other labels. `isolatingMailboxes` (`src/data/optimistic.ts`) returns the mailboxes with role `trash` or `junk`, and every membership test respects them:

- `belongsTo(mailbox, message, isolating)`: a message in an isolating mailbox belongs only to that mailbox. Otherwise a `flagged`-role mailbox shows flagged messages, any other `view` shows everything, and labels and folders show their members.
- `visibleMessages(thread, mailbox, isolating)`: the messages of a conversation that show in a mailbox. Inside Trash or Spam only those there; elsewhere all except those in Trash or Spam (your replies from Sent show in the Inbox's conversation too).
- `threadBelongsTo`: a conversation shows wherever one of its messages does.

The same functions patch cached lists: `patchList` and `patchThreadList` apply predicted changes (rows leave, come back at their date position on undo, as far as the loaded pages reach), `applyServerChanges` and `applyServerChangesToThreads` apply what live updates report, and `patchCounts` adjusts the unread and total counts. `rowsLeaving` (`src/data/listRows.ts`) tells the UI which rows an action removes from the current list, so the cursor can move on.

## Intents

Every change to mail is an intent: plain data that can be predicted, applied optimistically, undone and tested (`src/core/intents.ts`).

| `kind`           | Fields                 | Meaning                                                                             |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `archive`        | `ids`                  | Out of the Inbox                                                                    |
| `unarchive`      | `ids`                  | Back into the Inbox (undo of archive)                                               |
| `set-flags`      | `ids`, `flags`         | Sets `seen` and/or `flagged`; flags left out stay                                   |
| `move`           | `ids`, `from`, `to`    | Out of `from` (the list the user is in, possibly a view) into `to`                  |
| `set-labels`     | `ids`, `add`, `remove` | Adds and removes non-exclusive memberships (labels, Outlook categories)             |
| `trash`          | `ids`                  | Into the trash                                                                      |
| `untrash`        | `ids`                  | Out of the trash                                                                    |
| `report-spam`    | `ids`                  | Into the junk mailbox                                                               |
| `not-spam`       | `ids`                  | Out of the junk mailbox, into the Inbox                                             |
| `delete-forever` | `ids`                  | Permanent; has no inverse, so the UI asks for confirmation instead of offering undo |

`runIntent(provider, intent, signal)` maps each kind to one `MailProvider` method (`archive`, `setFlags`, `move`, `setLabels`, `trash`, …). How a provider carries it out is its own business: Gmail archives by removing the `INBOX` label, Graph moves the message to the Archive folder.

### Predicting: `planChanges`

`planChanges(intent, current, mailboxes, capabilities)` (`src/data/optimistic.ts`) predicts what an intent does to each message and returns a `MessageChange` (`id`, `before`, `after`, `deleted?`) for every message that actually changes. Messages that wouldn't change are left out, so an empty result means there is nothing to do. The account counts as a folder account if `capabilities.mailboxKinds` includes `folder`.

| Intent           | Label account (Gmail)                                   | Folder account (Outlook)                                                                                         |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `archive`        | Only messages in the Inbox; drops the Inbox             | Only messages in the Inbox; drops the Inbox and adds the archive-role folder                                     |
| `unarchive`      | Adds the Inbox                                          | Adds the Inbox and drops the archive folder                                                                      |
| `move`           | Adds `to`; drops `from` unless `from` is a view         | When `to` is a folder: drops every folder (categories stay) and adds `to`; a category as `to` works like a label |
| `set-labels`     | Removes `remove`, adds `add`                            | The same (categories)                                                                                            |
| `trash`          | Adds Trash; other labels stay (the message is isolated) | Drops every folder and adds Trash                                                                                |
| `untrash`        | Drops Trash                                             | Drops Trash and adds the Inbox                                                                                   |
| `report-spam`    | Adds Spam and drops the Inbox                           | Drops every folder and adds Junk                                                                                 |
| `not-spam`       | Drops Spam and adds the Inbox                           | Drops Junk and adds the Inbox                                                                                    |
| `set-flags`      | Changes the flags, if they differ                       | The same                                                                                                         |
| `delete-forever` | Marks the message `deleted`                             | The same                                                                                                         |

The UI then sends the intent with only the ids that change (`src/ui/actions/useMailActions.ts`): a folder provider would otherwise also move messages that an archive doesn't apply to. In conversation view an action on a row stands for the conversation's messages: flags and labels go on all of them; in a folder of a folder account, actions that move mail take only the conversation's messages in that folder, like Outlook. `useApplyIntent` (`src/data/mutations.ts`) applies the predicted changes to every cached list, conversation, message and count of the account, runs the intent, and restores the snapshot if the provider rejects it. [architecture.md](architecture.md) follows that flow end to end.

### Undoing: `inverseOf`

`inverseOf(intent, changes, { isFolder })` builds the intents that undo an intent from what actually changed, so undo never removes something a message already had before. Messages with the same change are grouped into one intent.

| Intent                     | Inverse without `isFolder` (label accounts)                  | Inverse with `isFolder` (folder accounts)                   |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `archive` / `unarchive`    | `unarchive` / `archive`                                      | The same                                                    |
| `set-flags`                | Per flag, the messages whose flag changed get it back        | The same                                                    |
| `set-labels`               | The exact membership diff, reversed                          | The same                                                    |
| `move`                     | The exact membership diff, reversed                          | `move` from the current folder back to the one it came from |
| `trash`                    | `untrash`                                                    | `move` back to the folder it came from (not just the Inbox) |
| `untrash`                  | `trash`                                                      | `trash`                                                     |
| `report-spam` / `not-spam` | The exact membership diff, reversed (e.g. back into a label) | `move` back to the folder it came from                      |
| `delete-forever`           | none                                                         | none                                                        |

`isFolder` tells which memberships are folders; the UI passes it for accounts whose `mailboxKinds` include `folder` (`useMailActions`). Moving back keeps a message's other memberships, such as Outlook categories. Undo steps also carry the changed summaries (`known`), so a message that has left every cached list can come back on undo.

## Capabilities

The UI asks what a provider can do instead of which provider it is. `ProviderCapabilities` (`src/core/provider.ts`) is a field of every `MailProvider`:

| Field                | Type                                           | Meaning                                                                                                                                                                                               | Gmail             | Microsoft Graph                      |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------ |
| `mailboxKinds`       | `MailboxKind[]`                                | The kinds the account uses. Including `folder` switches prediction, undo and wording to folder rules.                                                                                                 | `label`, `view`   | `folder`, `label`, `view`            |
| `archive`            | `boolean`                                      | `archive` and `unarchive` work                                                                                                                                                                        | yes               | yes                                  |
| `settableFlags`      | `(keyof MessageFlags)[]`                       | Flags `setFlags` can change (read/unread and star buttons)                                                                                                                                            | `seen`, `flagged` | `seen`, `flagged`                    |
| `move`               | `boolean`                                      | `move` works                                                                                                                                                                                          | yes               | yes                                  |
| `labels`             | `boolean`                                      | `setLabels` works: memberships can be added and removed freely                                                                                                                                        | yes               | yes (categories)                     |
| `trash`              | `boolean`                                      | `trash` and `untrash` work                                                                                                                                                                            | yes               | yes                                  |
| `spam`               | `boolean`                                      | `reportSpam` and `notSpam` work                                                                                                                                                                       | yes               | yes                                  |
| `deleteForever`      | `boolean`                                      | `deleteForever` and `emptyMailbox` work                                                                                                                                                               | yes               | yes                                  |
| `compose`            | `boolean`                                      | Drafts and sending work                                                                                                                                                                               | yes               | yes                                  |
| `contacts`           | `boolean`                                      | `searchContacts` works; otherwise address suggestions come from recent mail                                                                                                                           | yes (People API)  | yes (`me/people`)                    |
| `recentToo`          | `boolean` (optional)                           | Suggestions add people from recent mail after the contacts (IMAP: CardDAV address books may be small or missing)                                                                                      | no                | no                                   |
| `maxAttachmentBytes` | `number`                                       | Most bytes of attachments one mail may carry, inline images included                                                                                                                                  | 25 MiB            | 25 MiB; 20 MiB for personal accounts |
| `manageMailboxes`    | `boolean`                                      | `createMailbox`, `updateMailbox` and `deleteMailbox` work for the user's own mailboxes                                                                                                                | yes               | yes                                  |
| `mailboxEditing`     | `Partial<Record<MailboxKind, MailboxEditing>>` | What can be changed about own mailboxes, per kind. Kinds that are missing can't be created or changed.                                                                                                | `label`           | `folder`, `label`                    |
| `threads`            | `boolean`                                      | `listThreads` and `getThread` work: the conversation switch applies                                                                                                                                   | yes               | yes                                  |
| `senders`            | `boolean`                                      | `listSenders` works (From field, signatures)                                                                                                                                                          | yes               | yes                                  |
| `editSenders`        | `boolean`                                      | The user manages the From addresses in action0 (`saveSenders`, `catchAllDomains`): replies to `+tag` and catch-all addresses are offered too                                                          | no (send-as)      | yes                                  |
| `rawSource`          | `boolean`                                      | `getRawMessage` works: "Show original" (headers and source)                                                                                                                                           | yes               | yes                                  |
| `signatureStore`     | `"provider" \| "browser"`                      | Where `updateSignature` keeps signatures: with the provider, or only in this browser                                                                                                                  | `provider`        | `browser`                            |
| `roleNames`          | `"gmail" \| "outlook" \| "client"` (optional)  | Whose words name mailboxes with a role: Gmail's (Spam, Starred), Outlook's (Junk Email, Deleted Items) or a mail program's (Junk, Trash, Flagged). Unset: Outlook's for folder accounts, else Gmail's | unset (Gmail's)   | unset (Outlook's)                    |

`MailboxEditing` describes one kind:

```ts
export interface MailboxEditing {
  /** {@link MailboxChange.name} works (Outlook categories can't be renamed). */
  readonly rename: boolean;
  /** Colours one may get; empty if colours can't be set. */
  readonly colors: readonly MailboxColor[];
  /** They can be nested ({@link MailboxChange.parentId}). */
  readonly nest: boolean;
  /** They can be hidden from the folder list. */
  readonly hide: boolean;
}
```

| Kind                       | `rename` | `colors`                                         | `nest` | `hide` |
| -------------------------- | -------- | ------------------------------------------------ | ------ | ------ |
| Gmail `label`              | yes      | Gmail's 16 accepted pairs (`GMAIL_LABEL_COLORS`) | yes    | yes    |
| Graph `folder`             | yes      | none                                             | yes    | no     |
| Graph `label` (categories) | no       | Outlook's 25 presets (`OUTLOOK_CATEGORY_COLORS`) | no     | no     |

The mailbox context menu (`src/ui/mailboxes/mailboxMenuItems.ts`), the label dialog and Manage labels read these rules (`src/ui/labels/`). `NewMailbox.kind` chooses what `createMailbox` creates when an account has several editable kinds; it defaults to the account's own kind (an Outlook folder, not a category). `MailboxChange` leaves out what doesn't change and uses `null` to remove the parent or the colour.

Actions on a selection from several accounts (All inboxes) are offered when any of the accounts can do them, and each account only gets the intents it supports (`anyCan` in `src/ui/actions/useMailActions.ts`).

## Compose model

Outgoing mail is described in `src/core/compose.ts`; how the composer's content becomes that is in `src/compose/`, and saving and sending in `src/data/drafts.ts`.

### Drafts

```ts
export interface DraftInput {
  readonly id?: DraftId;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  /** The whole HTML body: what the user wrote plus any quote. */
  readonly html: string;
  /** Plain-text version of {@link html}. */
  readonly text: string;
  readonly attachments: readonly OutgoingAttachment[];
  readonly threading?: Threading;
  readonly from?: EmailAddress;
}
```

A `Draft` is a saved `DraftInput` with its `id` and the `messageId` of its current message. `MailProvider.saveDraft` creates a draft (no `id`) or replaces one, `sendDraft` sends a draft with its final content, and `draftIdOf` finds the draft behind a message in the Drafts mailbox. Gmail gives a draft's message a new id on every save; Graph keeps one id for the draft, which it also keeps in Sent Items. Drafts are always saved to the provider, never to browser storage.

`createDraftSync` (`src/data/drafts.ts`) queues the saves, sends and discards of one composer one after another, and later calls reuse the draft an earlier one created, so a composer never ends up with two drafts. Before each upload it loads the bytes of attachments that are parts of other messages, because a draft's own parts vanish when the draft is replaced. The undo-send wait happens in the UI before `send` is called (`src/ui/composer/useComposeActions.ts`).

### Attachments

```ts
export interface OutgoingAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  /** Set for inline images, which the HTML references as `cid:<contentId>`. */
  readonly contentId?: string;
  /** Where to fetch the bytes from while they aren't loaded. */
  readonly source?: PartSource;
  readonly content?: Blob;
}
```

One of `source` and `content` is always set. `content` holds the bytes: the `File` for your own files (`attachmentFromFile` in `src/compose/session.ts`, which gives inline images a new `<uuid>@action0` Content-ID), or a part of another message once loaded. `source` (`PartSource`: `messageId` and `attachmentId`) points at a part of another message, for forwards and reopened drafts (`attachmentOf`). `attachmentBytes` and `sentBytes` add up the size against `capabilities.maxAttachmentBytes`. Inline images go along only while the text or quote still references their `cid:` (`draftInputOf`).

### Body, quote and signature

`draftInputOf(content, id)` (`src/compose/session.ts`) turns a `ComposerContent` into a `DraftInput`: invalid addresses stay in the composer only, and the body is what the user wrote, then the signature, then the quote (`mailBody`), with a plain-text version from `htmlToText` (`src/compose/html.ts`). The quote sits in Gmail's `gmail_quote` marker and the signature in its `gmail_signature` marker, so Gmail collapses them and a reopened draft can be split again (`splitQuote`, `splitSignature` in `src/compose/quote.ts` and `src/compose/signature.ts`). Quotes are sanitized; replies drop the original's inline images, forwards keep them.

### Threading and reply rules

`Threading` keeps a reply or forward in its conversation: the provider's `threadId`, `inReplyTo` (the original's `Message-ID`) and `references` (oldest first). `threadingFor(original)` builds it for replies and forwards: the original's references plus its own `Message-ID`, without duplicates. Forwards also set `forward: true`, so a provider that distinguishes them (Graph's `createForward`) can record a forward rather than a reply.

The reply rules follow Gmail:

- `replyRecipients(original, mode, me)`: a reply goes to the Reply-To addresses, else the sender; reply all also goes to everyone else in To (as To) and Cc (as Cc). Replying to your own message goes to its original recipients. Your own addresses are left out unless nobody else is left.
- `replyFrom(original, senders, unlisted?)`: answer from the address of yours the original was sent to (To, then Cc), else the default sender (`defaultSender`). With `unlisted` (accounts with `editSenders`), an address that isn't set up counts too: a `+tag` of one of yours, or any address at one of the `catchAll` domains. It comes back as a `Sender` with `setUp: false`, the default's name, and the tagged address's signature (else the default's).
- `replySubject` and `forwardSubject` add "Re:" or "Fwd:" unless the subject already has a reply or forward prefix (English, German and a few other languages: `Re`, `AW`, `SV`, `Antw`, `VS`; `Fwd`, `Fw`, `WG`, `TR`, `VB`, `RV`).

Senders (`Sender` in `src/core/model.ts`) are the addresses an account can send from, each with its HTML signature as the provider stores it, and optionally a `replyTo` address and `bccSelf` (every mail from it also goes to it as Bcc). `sendingAs(sender, current, previous)` (`src/compose/session.ts`) gives the composer fields that follow the From address: From, the signature (unless the user removed the block), Reply-To, and the Bcc copy, taking the previous address's copy away. `DraftInput.replyTo` becomes the `Reply-To` header.

Accounts with `editSenders` keep their addresses as `SenderSettings` (address, name, `replyTo`, `bccSelf`, `isDefault`; signatures apart): `saveSenders(list, catchAll)` replaces them, and the account's own address always stays, first. `catchAllDomains` lists the domains the user ticked; only domains of the addresses count, so public ones (gmx.at) never do unless the user adds an address there and ticks it.

## Calendar model

The calendar model (`src/core/calendar.ts`) describes the calendars of one _source_ (an account, or an iCal subscription) and their events as occurrences in a date range, with repeating events already expanded by the provider.

### Calendars and events

A `Calendar` has an `id`, `name`, `color`, and says whether it is the account's `primary` one, whether it is ticked until the user decides (`shownByDefault`), whether its events can't be changed (`readOnly`), which `videoCall` new events can get (`googleMeet` or `teams`) and its `defaultReminders`.

A `CalendarEvent` is one occurrence: `title`, `start`, `end`, `location?`, `description?` (raw, **unsanitized** HTML or text), `meetingUrl?`, `organizer?`, `attendees` (each with a `ResponseStatus`, `optional?` and `resource?`), `myResponse?` (only when you're invited), `status` (`confirmed`, `tentative`, `cancelled`), `recurring`, `seriesId?` (opaque), `organizedByMe` (you organize it, or nobody does), `reminders?`, `uid?` (the iCalendar UID) and `webLink?`.

Times are an `EventTime`:

```ts
export type EventTime =
  | { readonly dateTime: string; readonly timeZone?: string }
  | { readonly date: string };
```

Timed events carry an ISO instant with offset plus the IANA zone they were planned in; all-day events carry local dates, and their end is exclusive (a one-day event ends the next day). `timeOf` turns either into epoch milliseconds (all-day dates at local midnight).

`CalendarProvider` is the calendar counterpart of `MailProvider`, described in [providers.md](providers.md). Its flags say what a source supports: `canRespond`, `canEdit`, `guestNotices` (`ask`: guests hear about changes only when asked, Google; `always`: Microsoft tells them whatever you do; `never`: nothing can tell them, a CalDAV server without scheduling and no account to send from), `maxReminders` and `reminderSync`. `access()` is `granted` or `missing`, because calendar access is optional per account; `requestAccess()` asks for it from a click, unless `setup` is `server` (CalDAV): then the UI opens the calendar server setup instead.

### Editing and series scopes

The editor works on an `EventDraft` (every field of a new or existing event); `EventChanges` are the fields that change (the calendar can't). `loadForEdit` returns an `EditableEvent`: the draft with its series' rule, whether the video call can't be taken off again (`videoCallFixed`, Teams), and whether this is the series' first occurrence.

`Repeat` holds the rules action0 creates: `daily`, `weekdays`, `weekly` (on the start's weekday), `monthly` (on its day of the month) and `yearly`, each ending never or `until` a day. Any other rule is `{ kind: "custom" }`: it is shown as "Custom" and left as it is. `src/core/recurrence.ts` converts between `Repeat` and RFC 5545 `RRULE` lines (as Google keeps them); Graph's own recurrence format has its counterpart in `src/providers/microsoft/recurrence.ts`.

Changes to a repeating event take a `SeriesScope`:

| Scope       | What changes                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `this`      | Only this occurrence (a repeat change is dropped: an occurrence can't repeat on its own)                                                                                                                    |
| `all`       | The series. Time changes move the series by the same amount (`moveLike`), and a weekly day or monthly date that named the old day follows to the new one (`retimeRule`)                                     |
| `following` | The series is split (`splitRule`): the old one ends just before this occurrence, and a new one starts there with the changes and what's left of a `COUNT`. On the first occurrence it is the same as `all`. |

Deleting with `following` ends the series before the occurrence (from the first occurrence on, it deletes the series). Every write takes `WriteOptions` (`notify`: tell the guests; ignored where `guestNotices` is `always`) and resolves to an `EventChange` whose `undo(options)` takes the change back.

### Time zones

`src/core/timeZones.ts` computes wall-clock times with nothing but `Intl`: `localZone()` is the browser's IANA zone, `wallTime(instant, zone)` what a clock in a zone shows, and `instantAt(date, time, zone)` the instant a clock shows a time (times skipped by a DST change resolve to the later side). New events use the browser's zone; edited ones keep theirs. Microsoft Graph names zones the Windows way, so its adapter translates (`src/providers/microsoft/zones.ts`).

### Reminders

An event's `reminders` are minutes before its start, on-screen ones only, as the provider stores them (Google's calendar defaults included). `src/core/reminders.ts` works out which are due:

- `reminderTimes` turns an event's reminders into due times; `reminderKey` names each one `<source>|<eventId>|<minutes>`, or `<source>|<eventId>` for a provider's own reminder.
- `dueReminders` returns what is due now, oldest first, leaving out cancelled and declined events, events that are over, and dismissed or still snoozed reminders. Sources whose provider keeps reminders itself (`reminderSync`: Outlook) use the provider's list of due times instead of the events' minutes.
- A `ReminderMark` records a dismiss or snooze and when the event ends; `liveMarks` forgets marks of events that are over. Marks are kept in the UI store (`src/state/uiStore.ts`), which persists to localStorage; with `reminderSync` they also go to the provider (`src/data/reminders.ts`).
- `upcomingRange(now)` is the range the reminder check loads: from yesterday to nine days ahead, in whole local days.

### Invitations and answers

A mail that carries a calendar invitation has `Message.invitation`: the event's iCalendar `uid` and the mail's `method` (`request`, `cancel` or `reply`). Gmail finds it in the mail's `text/calendar` part (`parseInvitation`, iMIP `METHOD` and the first `VEVENT`'s `UID`); Graph from Outlook's event messages. For a request, the reader looks the event up in the same account's calendar (`CalendarProvider.findInvitation(uid, signal, ics)`) and shows the answer buttons (`src/ui/reader/InvitationBar.tsx`). IMAP mails also carry the part itself (`Invitation.ics`): a CalDAV calendar then returns the invitation even when it isn't saved yet, as an event with `inCalendar: false` that answering puts into the default calendar; and a guest's answer (`reply`) is taken into the user's event with `applyReply` where the server doesn't do that. `respond(event, rsvp)` answers with an `Rsvp` (`accepted`, `tentative`, `declined`) and resolves to the updated event; `useRespond` (`src/data/calendar.ts`) applies the answer optimistically to every cached copy.

## Errors

Providers and auth sessions reject with one error type, `MailError` (`src/core/errors.ts`), except when an `AbortSignal` aborts, which rejects with the abort reason.

```ts
export class MailError extends Error {
  readonly code: MailErrorCode;
  /** HTTP status, if the error came from an HTTP response. */
  readonly status: number | undefined;
  /** A cause the interface can describe in its own language. */
  readonly reason: MailErrorReason | undefined;
  /** Values for the description of {@link reason} (a label's name, …). */
  readonly params: Readonly<Record<string, string>>;
}
```

`isMailError(error, code?)` narrows an unknown error, optionally to one code.

| `code`          | Meaning                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `auth-required` | The user has to sign in again, interactively                                                      |
| `not-found`     | The message, mailbox or other item no longer exists                                               |
| `rate-limited`  | The provider throttled the app and the retries ran out                                            |
| `network`       | The request never got a response                                                                  |
| `unavailable`   | The account can't do this right now: an optional service isn't enabled or a permission is missing |
| `provider`      | Any other error reported by the provider                                                          |

### Reasons and translation

A `reason` names a cause the app describes itself, so the interface can say it in its language. Errors without a reason show their message as it is, for example Google's or Outlook's own text. The reasons, by area:

| Area                   | Reasons                                                                                                                                                           | Raised in                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Sign-in                | `notConnected`, `signInAgain`, `signInUnavailable`, `signInFailed`, `signInClosed`, `signInBlocked`, `accessNotGranted`, `adminApprovalNeeded`, `wrongAccount`    | `src/auth/*`, `src/data/*` (account gone)                                                          |
| Requests               | `unreachable`, `tokenRejected`                                                                                                                                    | `src/providers/gmail/http.ts`, `src/providers/microsoft/http.ts`                                   |
| Drafts                 | `draftGone`, `noContent`, `attachmentUploadBlocked`, `attachmentUploadInterrupted`                                                                                | `src/data/drafts.ts`, the providers                                                                |
| Labels                 | `notALabel`, `labelNeedsName`, `labelNoSlash`, `labelExists`, `labelNotAllowed`, `labelInsideItself`                                                              | `src/providers/gmail/GmailProvider.ts`                                                             |
| Folders and categories | `notAFolder`, `folderNeedsName`, `folderExists`, `folderInsideItself`, `notACategory`, `categoryRename`, `categoryExists`, `categoryNeedsName`, `noArchiveFolder` | `src/providers/microsoft/GraphProvider.ts`                                                         |
| Mailboxes              | `systemMailbox`, `onlyTrashSpam`                                                                                                                                  | all mail providers                                                                                 |
| Contacts and settings  | `peopleApiDisabled`, `contactsDeclined`, `peopleUnavailable`, `settingsNotAllowed`                                                                                | the mail providers                                                                                 |
| Unsubscribe            | `needsHttps`, `senderUnreachable`, `senderRefused`                                                                                                                | `src/providers/oneClickUnsubscribe.ts`                                                             |
| Calendar               | `calendarAccessNeeded`, `calendarReadOnly`, `eventGone`, `icsBlocked`, `icsNotFound`, `icsUnreadable`, `icsBadUrl`                                                | the calendar providers and sessions, `src/core/calendar.ts`, `src/ui/calendar/useSubscriptions.ts` |
| Demo                   | `demoRefused`, `demoContactsOff`                                                                                                                                  | `src/providers/fake/*`                                                                             |

`params` fill in the description: a label or file `name`, the `service` that couldn't be reached, an HTTP `status`, an iCal `host`. Sign-in reasons name the provider in `params.provider` ("Google" if absent).

The UI turns an error into text with `errorMessage(error, t)` (`src/ui/common/errorMessage.ts`): a known `reason` is described by `t.errors.reasons[reason](params)`; otherwise `not-found`, `rate-limited` and `network` get general texts, and `auth-required`, `unavailable` and `provider` show the error's own message. The descriptions live in `src/i18n/texts/errors.ts`, in English and German. Both are typed as `Record<MailErrorReason, …>`, so a new reason without a text in either language fails the typecheck.

Errors also drive behaviour, not just text: an HTTP 401 makes the HTTP client call `AuthSession.markExpired()`, which brings up the Reconnect bar; `unavailable` from `searchContacts` makes address suggestions fall back to recent mail (`src/data/drafts.ts`); and `unavailable` from `updateSignature` makes Settings offer "Allow editing" (`src/ui/settings/SignatureSettings.tsx`).
