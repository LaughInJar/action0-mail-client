import type { Brand, MailboxId } from "./ids";

/**
 * Identifies a filter of an account (a Gmail filter id, an Outlook rule
 * id, a Sieve rule's place). Opaque; only its provider reads it.
 */
export type FilterId = Brand<string, "FilterId">;

/** Brands a raw string as a {@link FilterId}. */
export const asFilterId = (value: string): FilterId => value as FilterId;

/**
 * What a filter looks at. Every condition that is set must match; a list
 * matches when any of its values does. Matching follows each server's
 * rules: Gmail matches words, Outlook and Sieve text anywhere.
 */
export interface FilterConditions {
  /** The sender's address or name contains one of them. */
  readonly from: readonly string[];
  /** A To or Cc recipient contains one of them. */
  readonly to: readonly string[];
  /** The subject contains one of them. */
  readonly subject: readonly string[];
  /** "Has the words": the text (Outlook: or the subject) contains one of them. */
  readonly words: readonly string[];
  /** "Doesn't have": the text contains none of them. */
  readonly notWords: readonly string[];
  readonly hasAttachment: boolean;
  /** Larger or smaller than this many bytes. */
  readonly size?: {
    readonly compare: "larger" | "smaller";
    readonly bytes: number;
  };
}

/** What a filter does with matching mail; each provider supports some. */
export interface FilterActions {
  /** Gmail: "Skip the Inbox (archive it)". */
  readonly skipInbox: boolean;
  /** Outlook and Sieve: move into this folder. */
  readonly moveTo?: MailboxId;
  /** Gmail labels, Outlook categories. */
  readonly labels: readonly MailboxId[];
  readonly markRead: boolean;
  /** Gmail's star, Sieve's `\Flagged` (Outlook rules can't flag). */
  readonly star: boolean;
  /** Forward to these addresses (Gmail: one verified address). */
  readonly forwardTo: readonly string[];
  /** Into Trash / Deleted Items. */
  readonly trash: boolean;
  /** Gmail: "Never send it to Spam". */
  readonly neverSpam: boolean;
  /** Outlook and Sieve: no further rules for this mail. */
  readonly stop: boolean;
}

/** A filter as the editor makes it. */
export interface FilterSpec {
  /** Outlook and Sieve rules have names; Gmail filters don't. */
  readonly name?: string;
  readonly enabled: boolean;
  readonly conditions: FilterConditions;
  readonly actions: FilterActions;
}

/** A filter of an account, in the order the server runs them. */
export interface MailFilter extends FilterSpec {
  readonly id: FilterId;
  /**
   * It has parts action0 doesn't show (Gmail's "Categorize as", Outlook's
   * importance, …). Editing keeps them as they are.
   */
  readonly more: boolean;
  /**
   * Sieve code action0 can't read, as written: such a rule can only be
   * switched on or off and deleted.
   */
  readonly custom?: string;
  /** Outlook marks the rule as failing, or as made by an app that keeps it read-only. */
  readonly problem?: "error" | "readOnly";
}

/** One kind of {@link FilterConditions}. */
export type FilterCondition = keyof FilterConditions;
/** One kind of {@link FilterActions}. */
export type FilterAction = keyof FilterActions;

/** What an account's automatic reply can have. */
export interface AutoReplyCapabilities {
  /** Its own subject (Outlook replies with "Automatic reply: …"). */
  readonly subject: boolean;
  /** Formatted text; else plain text (Sieve). */
  readonly html: boolean;
  /** First and last day (Sieve: with the `date` extension). */
  readonly schedule: boolean;
  /** "Only people in my contacts". */
  readonly contactsOnly: boolean;
  /** A second message for people outside the organisation (Outlook work accounts). */
  readonly outside: boolean;
}

/** What an account's filters can do. */
export interface FilterCapabilities {
  readonly conditions: readonly FilterCondition[];
  readonly actions: readonly FilterAction[];
  /** Filters have names. */
  readonly names: boolean;
  /** Filters can be switched off without deleting them. */
  readonly toggle: boolean;
  /** Filters run in an order the user can change. */
  readonly order: boolean;
  /**
   * Where forwarding may go: only addresses verified with the provider
   * ({@link FilterSetup.forwardAddresses}), or any.
   */
  readonly forward?: "verified" | "any";
  /** Most forwarding addresses per filter. */
  readonly maxForward: number;
  /**
   * Where the server runs filters, so where "Also apply" looks: all mail
   * but Trash and Spam (Gmail), or the Inbox.
   */
  readonly scope: "all" | "inbox";
  /**
   * What the automatic reply can have; undefined when the server can't
   * send automatic replies (Sieve without the `vacation` extension).
   */
  readonly autoReply?: AutoReplyCapabilities;
}

/** An account's automatic reply (out of office, vacation). */
export interface AutoReply {
  readonly enabled: boolean;
  /** First day, "YYYY-MM-DD" in local time; none: from now on. */
  readonly start?: string;
  /** Last day, "YYYY-MM-DD" in local time; none: until switched off. */
  readonly end?: string;
  readonly subject: string;
  /** The message: HTML, or plain text where the server has no formatting. */
  readonly text: string;
  /** Only to people in the user's contacts. */
  readonly contactsOnly: boolean;
  /** Outlook work accounts: who outside the organisation gets which message. */
  readonly outside?: {
    readonly audience: "none" | "contacts" | "all";
    readonly text: string;
  };
}

/** Everything Settings → Filters shows for one account. */
export interface FilterSetup {
  readonly capabilities: FilterCapabilities;
  /** In the order the server runs them. */
  readonly filters: readonly MailFilter[];
  readonly autoReply: AutoReply;
  /** Gmail: the forwarding addresses verified in Gmail's settings. */
  readonly forwardAddresses?: readonly string[];
  /**
   * Changes need a permission the account didn't grant (Gmail's settings
   * permission): shown, but read-only, with "Allow editing".
   */
  readonly readOnly?: "permission";
}

/** Where a mail server account's filters are kept (a Sieve server). */
export interface FilterServer {
  readonly host: string;
  readonly port: number;
  /** The user entered it ("Use another server"), rather than it being found. */
  readonly chosen: boolean;
}

/**
 * Choosing the filter server, for providers that find it apart from the
 * mail server (Sieve). Rejects with a {@link MailError}.
 */
export interface FilterServerSettings {
  /** The server in use, if one was found or chosen (no network). */
  readonly current: () => Promise<FilterServer | undefined>;
  /**
   * Uses this server from now on (checked by logging in first), or forgets
   * the chosen one so the next load looks again (`null`).
   */
  readonly choose: (
    server: { readonly host: string; readonly port: number } | null,
  ) => Promise<void>;
}

/**
 * An account's filters and automatic reply, kept on the server (Gmail
 * filters, Outlook inbox rules, a Sieve script). Like {@link MailProvider}
 * it caches nothing, and rejects with a {@link MailError}.
 */
export interface FilterProvider {
  /**
   * The filters, automatic reply and what can be changed. A mail server
   * without a filter server rejects with `unavailable` (`noFilterServer`).
   */
  load(signal?: AbortSignal): Promise<FilterSetup>;
  /**
   * Only the automatic reply, for the notice above the list; `undefined`
   * when knowing it would mean looking for a filter server first.
   */
  autoReply(signal?: AbortSignal): Promise<AutoReply | undefined>;
  /**
   * Adds a filter, at `position` (an index into the filters) where the
   * order matters, else last.
   */
  create(
    spec: FilterSpec,
    position?: number,
    signal?: AbortSignal,
  ): Promise<MailFilter>;
  /**
   * Changes the parts of a filter action0 shows; the rest stays as it is.
   * The result may have a new id (Gmail can't change a filter in place).
   */
  update(
    id: FilterId,
    spec: FilterSpec,
    signal?: AbortSignal,
  ): Promise<MailFilter>;
  /** Switches a filter on or off (only with `toggle`). */
  setEnabled(
    id: FilterId,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Puts the filters into this order (only with `order`; all of them). */
  reorder(ids: readonly FilterId[], signal?: AbortSignal): Promise<void>;
  remove(id: FilterId, signal?: AbortSignal): Promise<void>;
  setAutoReply(reply: AutoReply, signal?: AbortSignal): Promise<void>;
  /** Choosing the filter server (Sieve only). */
  readonly filterServer?: FilterServerSettings;
  /**
   * A search, in the account's search syntax, for mail that matches the
   * conditions (for "Also apply to matching messages"). `hasAttachment`
   * may be left to the caller, which checks the messages it finds.
   */
  searchOf(conditions: FilterConditions): string;
}

/** Conditions that match nothing in particular yet. */
export const NO_CONDITIONS: FilterConditions = {
  from: [],
  to: [],
  subject: [],
  words: [],
  notWords: [],
  hasAttachment: false,
};

/** Actions that do nothing yet. */
export const NO_ACTIONS: FilterActions = {
  skipInbox: false,
  labels: [],
  markRead: false,
  star: false,
  forwardTo: [],
  trash: false,
  neverSpam: false,
  stop: false,
};

/** An automatic reply that is off. */
export const NO_AUTO_REPLY: AutoReply = {
  enabled: false,
  subject: "",
  text: "",
  contactsOnly: false,
};

/** The conditions test something. */
export function hasConditions(conditions: FilterConditions): boolean {
  return (
    conditions.from.length > 0 ||
    conditions.to.length > 0 ||
    conditions.subject.length > 0 ||
    conditions.words.length > 0 ||
    conditions.notWords.length > 0 ||
    conditions.hasAttachment ||
    conditions.size !== undefined
  );
}

/** The actions do something (`stop` alone does nothing to the mail). */
export function hasActions(actions: FilterActions): boolean {
  return (
    actions.skipInbox ||
    actions.moveTo !== undefined ||
    actions.labels.length > 0 ||
    actions.markRead ||
    actions.star ||
    actions.forwardTo.length > 0 ||
    actions.trash ||
    actions.neverSpam
  );
}

/**
 * Whether the automatic reply answers mail today (`today`: "YYYY-MM-DD",
 * local): switched on, and today is within its days.
 */
export function autoReplyActive(reply: AutoReply, today: string): boolean {
  if (!reply.enabled) return false;
  if (reply.start !== undefined && today < reply.start) return false;
  if (reply.end !== undefined && today > reply.end) return false;
  return true;
}
