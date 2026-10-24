import type { MailboxId, MessageKey } from "../../core/ids";
import type { EmailAddress, Mailbox, MessageSummary } from "../../core/model";
import type { ListRow } from "../../data/listRows";
import { visibleMessages } from "../../data/optimistic";
import { displayName, displayNames } from "../common/format";
import type { I18n } from "../../i18n/context";

/** The account a row belongs to, shown in All inboxes. */
export interface RowAccount {
  readonly email: string;
  /** CSS colour. */
  readonly color: string;
}

/** What a row of the message list shows. */
export interface RowView {
  readonly key: MessageKey;
  /** All inboxes: the row's account. */
  readonly account?: RowAccount;
  /** Sender, recipients (Sent, Drafts) or a conversation's senders. */
  readonly who: string;
  /** Messages in the conversation, when more than one. */
  readonly count?: number;
  /** The conversation has a draft. */
  readonly draft: boolean;
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly unread: boolean;
  readonly flagged: boolean;
  readonly hasAttachments: boolean;
}

/** How rows are described in a list. */
export interface RowContext {
  readonly mailbox: Mailbox | undefined;
  readonly isolating: ReadonlySet<MailboxId>;
  /** The account's own addresses (lower case): shown as "me". */
  readonly mine: ReadonlySet<string>;
  /** Show recipients instead of senders (Sent, Drafts). */
  readonly showRecipients: boolean;
  /** The drafts mailbox: its messages in a conversation show as "Draft". */
  readonly drafts: MailboxId | undefined;
  readonly t: I18n;
}

const firstName = (address: EmailAddress | undefined, unknown: string) =>
  displayName(address, unknown).split(/\s+/)[0] ?? "";

/** "Anna, me, Lukas"; long lists keep the first and the last two. */
function senders(
  messages: readonly MessageSummary[],
  mine: ReadonlySet<string>,
  t: I18n,
): string {
  const me = t.common.me;
  const unknown = t.common.unknownSender;
  const names: string[] = [];
  for (const message of messages) {
    const own =
      message.from !== undefined &&
      mine.has(message.from.address.toLowerCase());
    const name = own ? me : firstName(message.from, unknown);
    if (names.at(-1) !== name && !names.includes(name)) names.push(name);
  }
  if (names.length === 1 && names[0] !== me) {
    const only = messages.find((message) => message.from !== undefined);
    return displayName(only?.from, unknown);
  }
  return names.length > 3
    ? [names[0], "…", ...names.slice(-2)].join(", ")
    : names.join(", ");
}

/** The display of one row: a message, or a conversation. */
export function rowView(
  row: ListRow,
  context: RowContext,
  account?: RowAccount,
): RowView {
  const { thread, summary } = row;
  const identity = { key: row.key, ...(account ? { account } : {}) };
  if (!thread) {
    return {
      ...identity,
      who: context.showRecipients
        ? `${context.t.common.to}: ${displayNames(summary.to) || context.t.common.noRecipients}`
        : displayName(summary.from, context.t.common.unknownSender),
      draft: false,
      subject: summary.subject,
      snippet: summary.snippet,
      receivedAt: summary.receivedAt,
      unread: !summary.flags.seen,
      flagged: summary.flags.flagged,
      hasAttachments: summary.hasAttachments,
    };
  }
  const shown = context.mailbox
    ? visibleMessages(thread, context.mailbox, context.isolating)
    : thread.messages;
  const messages = shown.length > 0 ? shown : thread.messages;
  const { drafts } = context;
  const isDraft = (message: MessageSummary) =>
    drafts !== undefined && message.mailboxIds.includes(drafts);
  const sent = messages.filter((message) => !isDraft(message));
  const first = messages[0] ?? summary;
  return {
    ...identity,
    who: senders(sent.length > 0 ? sent : messages, context.mine, context.t),
    ...(messages.length > 1 ? { count: messages.length } : {}),
    draft: messages.some(isDraft),
    subject: first.subject,
    snippet: summary.snippet,
    receivedAt: summary.receivedAt,
    unread: messages.some((message) => !message.flags.seen),
    flagged: messages.some((message) => message.flags.flagged),
    hasAttachments: messages.some((message) => message.hasAttachments),
  };
}
