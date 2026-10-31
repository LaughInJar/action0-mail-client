import type { ScopedSession } from "../../auth/types";
import { isMailError, MailError } from "../../core/errors";
import {
  asFilterId,
  NO_ACTIONS,
  type AutoReply,
  type FilterActions,
  type FilterCapabilities,
  type FilterConditions,
  type FilterId,
  type FilterProvider,
  type FilterSetup,
  type FilterSpec,
  type MailFilter,
} from "../../core/filters";
import { asMailboxId, type MailboxId } from "../../core/ids";
import { dayOf, endOfDay, lastDayOf, startOfDay } from "../localDays";
import type { GmailHttp } from "./http";

/**
 * Changing Gmail settings: signatures, filters, the vacation responder.
 * Optional: declined, they are read-only.
 */
export const SETTINGS_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";

/** A filter's criteria (`users.settings.filters`). */
export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "unspecified" | "smaller" | "larger";
  [key: string]: unknown;
}

/** A filter's action. */
export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
  [key: string]: unknown;
}

/** A Gmail filter. */
export interface GmailFilter {
  id: string;
  criteria?: GmailFilterCriteria;
  action?: GmailFilterAction;
}

/** The vacation responder (`users.settings.getVacation`). */
export interface GmailVacation {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  responseBodyHtml?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  /** Epoch ms, as a string. */
  startTime?: string;
  endTime?: string;
  [key: string]: unknown;
}

/** A forwarding address (`users.settings.forwardingAddresses`). */
interface GmailForwardingAddress {
  forwardingEmail: string;
  verificationStatus?: "accepted" | "pending" | "verificationStatusUnspecified";
}

/** Criteria action0 shows; any other criterion is kept as it is. */
const KNOWN_CRITERIA = new Set([
  "from",
  "to",
  "subject",
  "query",
  "negatedQuery",
  "hasAttachment",
  "size",
  "sizeComparison",
]);

/** Labels whose removal is one of action0's actions. */
const REMOVALS: Readonly<Record<string, keyof FilterActions>> = {
  INBOX: "skipInbox",
  UNREAD: "markRead",
  SPAM: "neverSpam",
};

/** System labels whose addition is one of action0's actions. */
const ADDITIONS: Readonly<Record<string, keyof FilterActions>> = {
  STARRED: "star",
  TRASH: "trash",
};

/** The user's own labels (`Label_1`, …); system labels are upper case words. */
const isUserLabel = (id: string) => id.startsWith("Label_");

const CAPABILITIES: FilterCapabilities = {
  conditions: [
    "from",
    "to",
    "subject",
    "words",
    "notWords",
    "hasAttachment",
    "size",
  ],
  actions: [
    "skipInbox",
    "labels",
    "markRead",
    "star",
    "forwardTo",
    "trash",
    "neverSpam",
  ],
  names: false,
  toggle: false,
  order: false,
  forward: "verified",
  maxForward: 1,
  scope: "all",
  autoReply: {
    subject: true,
    html: true,
    schedule: true,
    contactsOnly: true,
    outside: false,
  },
};

/**
 * Splits a criterion into the values it accepts any of: `a OR b`,
 * `(a OR b)` and `{a b}` (Gmail's own spellings); anything else is one
 * value. Quotes and nested parentheses stay inside their value.
 */
export function splitAlternatives(text: string): string[] {
  let value = text.trim();
  if (value === "") return [];
  if (wraps(value, "{", "}"))
    return splitTopLevel(value.slice(1, -1), (rest) => /^\s+/.exec(rest));
  while (wraps(value, "(", ")")) value = value.slice(1, -1).trim();
  return splitTopLevel(value, (rest) => /^\s+OR\s+/.exec(rest));
}

/** `text` starts with `open` and the matching `close` is its last character. */
function wraps(text: string, open: string, close: string): boolean {
  if (!text.startsWith(open) || !text.endsWith(close)) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0 && index < text.length - 1) return false;
  }
  return depth === 0;
}

/** Splits where `separator` matches outside quotes, parentheses and braces. */
function splitTopLevel(
  text: string,
  separator: (rest: string) => RegExpExecArray | null,
): string[] {
  const values: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "(" || char === "{") depth++;
    if (char === ")" || char === "}") depth--;
    if (depth !== 0) continue;
    const match = separator(text.slice(index));
    if (match && index > start) {
      values.push(text.slice(start, index));
      index += match[0].length - 1;
      start = index + 1;
    }
  }
  values.push(text.slice(start));
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** Values as one criterion: `a OR b`. */
const joinAlternatives = (values: readonly string[]) =>
  values.map((value) => value.trim()).join(" OR ");

/** A Gmail filter in the domain model. */
export function toMailFilter(filter: GmailFilter): MailFilter {
  const criteria = filter.criteria ?? {};
  const action = filter.action ?? {};
  let more = Object.entries(criteria).some(
    ([key, value]) => !KNOWN_CRITERIA.has(key) && isSet(value),
  );
  const size =
    criteria.size !== undefined &&
    (criteria.sizeComparison === "larger" ||
      criteria.sizeComparison === "smaller")
      ? { compare: criteria.sizeComparison, bytes: criteria.size }
      : undefined;
  const conditions: FilterConditions = {
    from: splitAlternatives(criteria.from ?? ""),
    to: splitAlternatives(criteria.to ?? ""),
    subject: splitAlternatives(criteria.subject ?? ""),
    words: splitAlternatives(criteria.query ?? ""),
    notWords: splitAlternatives(criteria.negatedQuery ?? ""),
    hasAttachment: criteria.hasAttachment === true,
    ...(size ? { size } : {}),
  };

  const flags: Partial<Record<keyof FilterActions, true>> = {};
  const labels: MailboxId[] = [];
  for (const id of action.addLabelIds ?? []) {
    const known = ADDITIONS[id];
    if (known) flags[known] = true;
    else if (isUserLabel(id)) labels.push(asMailboxId(id));
    else more = true;
  }
  for (const id of action.removeLabelIds ?? []) {
    const known = REMOVALS[id];
    if (known) flags[known] = true;
    else more = true;
  }
  if (
    Object.entries(action).some(
      ([key, value]) =>
        !["addLabelIds", "removeLabelIds", "forward"].includes(key) &&
        isSet(value),
    )
  )
    more = true;
  const actions: FilterActions = {
    ...NO_ACTIONS,
    skipInbox: flags.skipInbox === true,
    markRead: flags.markRead === true,
    neverSpam: flags.neverSpam === true,
    star: flags.star === true,
    trash: flags.trash === true,
    labels,
    forwardTo: action.forward ? [action.forward] : [],
  };
  return {
    id: asFilterId(filter.id),
    enabled: true,
    conditions,
    actions,
    more,
  };
}

/** A value that means something (not empty, not `false`). */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== "";
}

/**
 * A spec as a Gmail filter, keeping what `original` has that action0
 * doesn't show (other criteria, other labels added or removed).
 */
export function toGmailFilter(
  spec: FilterSpec,
  original?: GmailFilter,
): Omit<GmailFilter, "id"> {
  const { conditions, actions } = spec;
  const kept = Object.fromEntries(
    Object.entries(original?.criteria ?? {}).filter(
      ([key]) => !KNOWN_CRITERIA.has(key),
    ),
  );
  const criteria: GmailFilterCriteria = { ...kept };
  const set = (key: string, values: readonly string[]) => {
    if (values.length > 0) criteria[key] = joinAlternatives(values);
  };
  set("from", conditions.from);
  set("to", conditions.to);
  set("subject", conditions.subject);
  set("query", conditions.words);
  set("negatedQuery", conditions.notWords);
  if (conditions.hasAttachment) criteria.hasAttachment = true;
  if (conditions.size) {
    criteria.size = conditions.size.bytes;
    criteria.sizeComparison = conditions.size.compare;
  }

  const before = original?.action ?? {};
  const add = (before.addLabelIds ?? []).filter(
    (id) => !(id in ADDITIONS) && !isUserLabel(id),
  );
  const remove = (before.removeLabelIds ?? []).filter(
    (id) => !(id in REMOVALS),
  );
  if (actions.star) add.push("STARRED");
  if (actions.trash) add.push("TRASH");
  add.push(...actions.labels);
  if (actions.skipInbox) remove.push("INBOX");
  if (actions.markRead) remove.push("UNREAD");
  if (actions.neverSpam) remove.push("SPAM");
  const otherActions = Object.fromEntries(
    Object.entries(before).filter(
      ([key]) => !["addLabelIds", "removeLabelIds", "forward"].includes(key),
    ),
  );
  const forward = actions.forwardTo[0];
  return {
    criteria,
    action: {
      ...otherActions,
      ...(add.length > 0 ? { addLabelIds: add } : {}),
      ...(remove.length > 0 ? { removeLabelIds: remove } : {}),
      ...(forward ? { forward } : {}),
    },
  };
}

/** The vacation responder as an automatic reply. */
export function toAutoReply(vacation: GmailVacation): AutoReply {
  const start = Number(vacation.startTime);
  const end = Number(vacation.endTime);
  return {
    enabled: vacation.enableAutoReply === true,
    ...(vacation.startTime !== undefined && Number.isFinite(start)
      ? { start: dayOf(start) }
      : {}),
    ...(vacation.endTime !== undefined && Number.isFinite(end)
      ? { end: lastDayOf(end) }
      : {}),
    subject: vacation.responseSubject ?? "",
    text:
      vacation.responseBodyHtml ??
      plainToHtml(vacation.responseBodyPlainText ?? ""),
    contactsOnly: vacation.restrictToContacts === true,
  };
}

/**
 * An automatic reply as the whole vacation resource (`PUT` replaces it),
 * keeping what `before` has that action0 doesn't show (`restrictToDomain`).
 */
export function toVacation(
  reply: AutoReply,
  before: GmailVacation,
): GmailVacation {
  const {
    startTime: _start,
    endTime: _end,
    responseBodyPlainText: _plain,
    ...kept
  } = before;
  return {
    ...kept,
    enableAutoReply: reply.enabled,
    responseSubject: reply.subject,
    // Gmail uses the HTML when there is some, so the plain text goes.
    responseBodyHtml: reply.text,
    restrictToContacts: reply.contactsOnly,
    ...(reply.start === undefined
      ? {}
      : { startTime: String(startOfDay(reply.start)) }),
    // Gmail's own settings end at the last moment of the last day.
    ...(reply.end === undefined
      ? {}
      : { endTime: String(endOfDay(reply.end) - 1) }),
  };
}

/** Plain text as HTML (Gmail's plain-text vacation messages). */
function plainToHtml(text: string): string {
  if (text === "") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<div>${line === "" ? "<br>" : line}</div>`)
    .join("");
}

/**
 * The Gmail search for mail the conditions match, written the way Gmail
 * matches a filter's criteria.
 */
export function gmailSearchOf(conditions: FilterConditions): string {
  const parts: string[] = [];
  const group = (values: readonly string[]) =>
    values.length === 1 && !/\s/.test(values[0] ?? "")
      ? (values[0] ?? "")
      : `(${joinAlternatives(values)})`;
  if (conditions.from.length > 0) parts.push(`from:${group(conditions.from)}`);
  if (conditions.to.length > 0) parts.push(`to:${group(conditions.to)}`);
  if (conditions.subject.length > 0)
    parts.push(`subject:${group(conditions.subject)}`);
  if (conditions.words.length > 0) parts.push(group(conditions.words));
  if (conditions.notWords.length > 0)
    parts.push(`-${group(conditions.notWords)}`);
  if (conditions.hasAttachment) parts.push("has:attachment");
  if (conditions.size)
    parts.push(`${conditions.size.compare}:${String(conditions.size.bytes)}`);
  return parts.join(" ");
}

/**
 * Gmail filters and the vacation responder (`users.settings`). Reading
 * works with the mail permission; changes need `gmail.settings.basic`.
 * Gmail can't change a filter, so an edit creates the new version and then
 * deletes the old one; filters have no names, order or on/off switch.
 */
export class GmailFilterProvider implements FilterProvider {
  readonly #http: GmailHttp;
  readonly #session: ScopedSession;

  constructor(http: GmailHttp, session: ScopedSession) {
    this.#http = http;
    this.#session = session;
  }

  async load(signal?: AbortSignal): Promise<FilterSetup> {
    const [filters, vacation, forwarding] = await Promise.all([
      this.#http.get<{ filter?: GmailFilter[] }>(
        "settings/filters",
        undefined,
        signal,
      ),
      this.#vacation(signal),
      this.#forwardAddresses(signal),
    ]);
    return {
      capabilities: CAPABILITIES,
      filters: (filters.filter ?? []).map(toMailFilter),
      autoReply: toAutoReply(vacation),
      forwardAddresses: forwarding,
      ...(this.#session.hasScopes([SETTINGS_SCOPE])
        ? {}
        : { readOnly: "permission" as const }),
    };
  }

  async autoReply(signal?: AbortSignal): Promise<AutoReply> {
    return toAutoReply(await this.#vacation(signal));
  }

  async create(
    spec: FilterSpec,
    _position?: number,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    return toMailFilter(await this.#post(toGmailFilter(spec), spec, signal));
  }

  async update(
    id: FilterId,
    spec: FilterSpec,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    const original = await this.#http.get<GmailFilter>(
      `settings/filters/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    const created = await this.#post(
      toGmailFilter(spec, original),
      spec,
      signal,
    );
    // Only now: if creating failed, the old filter is still there.
    await this.#write(() =>
      this.#http.delete(`settings/filters/${encodeURIComponent(id)}`, signal),
    );
    return toMailFilter(created);
  }

  setEnabled(): Promise<void> {
    return Promise.reject(
      new MailError("unavailable", "Gmail filters can't be switched off."),
    );
  }

  reorder(): Promise<void> {
    return Promise.reject(
      new MailError("unavailable", "Gmail filters have no order."),
    );
  }

  async remove(id: FilterId, signal?: AbortSignal): Promise<void> {
    await this.#write(() =>
      this.#http.delete(`settings/filters/${encodeURIComponent(id)}`, signal),
    );
  }

  async setAutoReply(reply: AutoReply, signal?: AbortSignal): Promise<void> {
    const before = await this.#vacation(signal);
    await this.#write(() =>
      this.#http.put("settings/vacation", toVacation(reply, before), signal),
    );
  }

  searchOf(conditions: FilterConditions): string {
    return gmailSearchOf(conditions);
  }

  #vacation(signal?: AbortSignal): Promise<GmailVacation> {
    return this.#http.get<GmailVacation>(
      "settings/vacation",
      undefined,
      signal,
    );
  }

  async #forwardAddresses(signal?: AbortSignal): Promise<string[]> {
    const answer = await this.#http.get<{
      forwardingAddresses?: GmailForwardingAddress[];
    }>("settings/forwardingAddresses", undefined, signal);
    return (answer.forwardingAddresses ?? [])
      .filter((address) => address.verificationStatus === "accepted")
      .map((address) => address.forwardingEmail);
  }

  /** Creates a filter, after checking its forwarding address is verified. */
  async #post(
    filter: Omit<GmailFilter, "id">,
    spec: FilterSpec,
    signal: AbortSignal | undefined,
  ): Promise<GmailFilter> {
    const forward = spec.actions.forwardTo[0];
    if (forward !== undefined) {
      const verified = await this.#forwardAddresses(signal);
      if (
        !verified.some(
          (address) => address.toLowerCase() === forward.toLowerCase(),
        )
      )
        throw forwardNotAllowed(forward);
    }
    return this.#write(
      () =>
        this.#http.post<GmailFilter>("settings/filters", filter, signal, {
          retry: false,
        }),
      forward,
    );
  }

  /** Runs a change, saying why Gmail refused it where action0 knows. */
  async #write<T>(change: () => Promise<T>, forward?: string): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (!isMailError(error)) throw error;
      if (error.status === 403)
        throw new MailError(
          "unavailable",
          "Changing Gmail settings wasn’t allowed for this account.",
          { status: 403, cause: error, reason: "settingsNotAllowed" },
        );
      if (error.status === 400 && /already exists/i.test(error.message))
        throw new MailError("provider", error.message, {
          status: 400,
          cause: error,
          reason: "filterExists",
        });
      if (
        error.status === 400 &&
        forward !== undefined &&
        /forward/i.test(error.message)
      )
        throw forwardNotAllowed(forward, error);
      throw error;
    }
  }
}

const forwardNotAllowed = (address: string, cause?: unknown) =>
  new MailError(
    "provider",
    `${address} isn't a verified forwarding address in Gmail.`,
    { cause, reason: "forwardNotAllowed", params: { address } },
  );
