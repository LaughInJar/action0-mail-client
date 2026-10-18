/**
 * Outgoing mail: what a draft contains, and the provider-agnostic rules for
 * replies and forwards (recipients, subjects, threading headers).
 */
import type { AttachmentId, DraftId, MessageId, ThreadId } from "./ids";
import type { EmailAddress, Message } from "./model";

/** A part of an original message that a forward carries along. */
export interface ForwardedPart {
  readonly messageId: MessageId;
  readonly attachmentId: AttachmentId;
  readonly filename: string;
  readonly mimeType: string;
  /** Size in bytes. */
  readonly size: number;
  /** Set for inline images that the quoted HTML references as `cid:`. */
  readonly contentId?: string;
  /**
   * The bytes, once loaded (kept in memory while composing, so every save
   * doesn't download them again). Providers fetch them if absent.
   */
  readonly content?: Blob;
}

/** What keeps a reply or forward in its conversation. */
export interface Threading {
  /** The provider's conversation (Gmail `threadId`). */
  readonly threadId?: ThreadId;
  /** `Message-ID` of the message replied to. */
  readonly inReplyTo?: string;
  /** `References` header: the conversation's Message-IDs, oldest first. */
  readonly references: readonly string[];
}

/** The content of a draft, as the composer edits it. */
export interface DraftInput {
  /** The draft to replace; absent for a new draft. */
  readonly id?: DraftId;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  /** The whole HTML body: what the user wrote plus any quote. */
  readonly html: string;
  /** Plain-text version of {@link html}. */
  readonly text: string;
  /** Parts of the original message that a forward includes. */
  readonly forwarded: readonly ForwardedPart[];
  readonly threading?: Threading;
}

/** A saved draft. */
export interface Draft extends DraftInput {
  readonly id: DraftId;
  /** Id of the draft's current message (changes with every save in Gmail). */
  readonly messageId: MessageId;
}

/** How a composer was started. */
export type ReplyMode = "reply" | "reply-all";

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** Removes duplicates (case-insensitive), keeping the first occurrence. */
export function uniqueAddresses(
  addresses: readonly EmailAddress[],
  except: readonly EmailAddress[] = [],
): EmailAddress[] {
  const seen = new Set(except.map((a) => a.address.toLowerCase()));
  return addresses.filter((a) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Who a reply goes to. Like Gmail:
 * - reply: the Reply-To addresses, or else the sender;
 * - reply all: also everyone else in To (to "To") and Cc (to "Cc");
 * - replying to your own message goes to its original recipients.
 * Your own addresses (`me`) are left out, unless nobody else is left.
 */
export function replyRecipients(
  original: Message,
  mode: ReplyMode,
  me: readonly string[],
): { to: EmailAddress[]; cc: EmailAddress[] } {
  const isMine = (address: EmailAddress) =>
    me.some((mine) => sameAddress(mine, address.address));
  const notMine = (list: readonly EmailAddress[]) =>
    list.filter((address) => !isMine(address));
  const sender = original.replyTo.length
    ? original.replyTo
    : original.from
      ? [original.from]
      : [];
  const fromMe = original.from !== undefined && isMine(original.from);

  let to: EmailAddress[];
  if (fromMe) {
    to = notMine(original.to);
    if (to.length === 0) to = [...original.to];
  } else {
    to = [...sender, ...(mode === "reply-all" ? notMine(original.to) : [])];
  }
  to = uniqueAddresses(to);
  const cc =
    mode === "reply-all" ? uniqueAddresses(notMine(original.cc), to) : [];
  return { to, cc };
}

const REPLY_PREFIX = /^\s*(re|aw|sv|antw|vs)(\[\d+\])?\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd?|wg|tr|vb|rv)\s*:/i;

/** "Re: …", unless the subject already is a reply. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return REPLY_PREFIX.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim();
}

/** "Fwd: …", unless the subject already is a forward. */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return FORWARD_PREFIX.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim();
}

/** Headers that file a reply or forward of `original` into its conversation. */
export function threadingFor(original: Message): Threading {
  const own = original.internetMessageId;
  return {
    ...(original.threadId === undefined ? {} : { threadId: original.threadId }),
    ...(own === undefined ? {} : { inReplyTo: own }),
    references: [
      ...new Set([...original.references, ...(own === undefined ? [] : [own])]),
    ],
  };
}
