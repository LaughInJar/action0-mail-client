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
import { asMailboxId } from "../../core/ids";
import { instantAt } from "../../core/timeZones";
import { dayOf, endOfDay, lastDayOf, startOfDay } from "../localDays";
import { categoryId, categoryName } from "./folders";
import type { GraphHttp } from "./http";
import { ianaZone, loadZones } from "./zones";

/** A recipient as rules write them. */
interface GraphRecipient {
  emailAddress: { address?: string; name?: string };
}

/** `messageRulePredicates` (conditions and exceptions); other keys are kept. */
export interface GraphRulePredicates {
  senderContains?: string[];
  fromAddresses?: GraphRecipient[];
  recipientContains?: string[];
  sentToAddresses?: GraphRecipient[];
  subjectContains?: string[];
  bodyOrSubjectContains?: string[];
  hasAttachments?: boolean;
  /** In kilobytes. */
  withinSizeRange?: { minimumSize?: number; maximumSize?: number };
  [key: string]: unknown;
}

/** `messageRuleActions`; other keys are kept. */
export interface GraphRuleActions {
  moveToFolder?: string;
  assignCategories?: string[];
  markAsRead?: boolean;
  forwardTo?: GraphRecipient[];
  delete?: boolean;
  stopProcessingRules?: boolean;
  [key: string]: unknown;
}

/** An inbox rule (`messageRule`). */
export interface GraphMessageRule {
  id: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  hasError?: boolean;
  isReadOnly?: boolean;
  conditions?: GraphRulePredicates | null;
  exceptions?: GraphRulePredicates | null;
  actions?: GraphRuleActions | null;
}

/** A time in a zone (`dateTimeTimeZone`). */
interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

/** `automaticRepliesSetting` of `mailboxSettings`. */
export interface GraphAutomaticReplies {
  status?: "disabled" | "alwaysEnabled" | "scheduled";
  externalAudience?: "none" | "contactsOnly" | "all";
  internalReplyMessage?: string;
  externalReplyMessage?: string;
  scheduledStartDateTime?: GraphDateTime;
  scheduledEndDateTime?: GraphDateTime;
}

const RULES = "me/mailFolders/inbox/messageRules";

const KNOWN_CONDITIONS = new Set([
  "senderContains",
  "fromAddresses",
  "recipientContains",
  "sentToAddresses",
  "subjectContains",
  "bodyOrSubjectContains",
  "hasAttachments",
  "withinSizeRange",
]);
const KNOWN_EXCEPTIONS = new Set(["bodyOrSubjectContains"]);
const KNOWN_ACTIONS = new Set([
  "moveToFolder",
  "assignCategories",
  "markAsRead",
  "forwardTo",
  "delete",
  "stopProcessingRules",
]);

/**
 * The largest size a "larger than" rule allows (1 GB in KB): Outlook
 * only has size ranges, and no mail comes near it.
 */
const OPEN_MAX_KB = 1_048_576;

/**
 * An automatic reply without a last day still needs one in Outlook: it
 * gets one this many days after the first, and reads back as open.
 */
const OPEN_END_DAYS = 3650;
const OPEN_END_MIN_MS = (OPEN_END_DAYS / 2) * 86_400_000;

/** An address on its own (rather than part of one or a name). */
const isAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** A value that means something (not empty, not `false`). */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== "";
}

const addressesOf = (recipients: readonly GraphRecipient[] | undefined) =>
  (recipients ?? []).flatMap((recipient) =>
    recipient.emailAddress.address ? [recipient.emailAddress.address] : [],
  );

const recipients = (addresses: readonly string[]): GraphRecipient[] =>
  addresses.map((address) => ({ emailAddress: { address } }));

/** A size range action0 can show as "larger" or "smaller", if it is one. */
function sizeOf(
  range: GraphRulePredicates["withinSizeRange"],
): FilterConditions["size"] {
  if (!range) return undefined;
  const min = range.minimumSize ?? 0;
  const max = range.maximumSize ?? OPEN_MAX_KB;
  if (max >= OPEN_MAX_KB && min > 0)
    return { compare: "larger", bytes: min * 1024 };
  if (min <= 0 && max < OPEN_MAX_KB)
    return { compare: "smaller", bytes: max * 1024 };
  return undefined;
}

/** An Outlook rule in the domain model. */
export function toMailFilter(rule: GraphMessageRule): MailFilter {
  const conditions = rule.conditions ?? {};
  const exceptions = rule.exceptions ?? {};
  const actions = rule.actions ?? {};
  const size = sizeOf(conditions.withinSizeRange);
  const more =
    Object.entries(conditions).some(
      ([key, value]) => !KNOWN_CONDITIONS.has(key) && isSet(value),
    ) ||
    Object.entries(exceptions).some(
      ([key, value]) => !KNOWN_EXCEPTIONS.has(key) && isSet(value),
    ) ||
    Object.entries(actions).some(
      ([key, value]) => !KNOWN_ACTIONS.has(key) && isSet(value),
    ) ||
    (conditions.withinSizeRange !== undefined && size === undefined);
  const filterActions: FilterActions = {
    ...NO_ACTIONS,
    ...(actions.moveToFolder
      ? { moveTo: asMailboxId(actions.moveToFolder) }
      : {}),
    labels: (actions.assignCategories ?? []).map(categoryId),
    markRead: actions.markAsRead === true,
    forwardTo: addressesOf(actions.forwardTo),
    trash: actions.delete === true,
    stop: actions.stopProcessingRules === true,
  };
  return {
    id: asFilterId(rule.id),
    ...(rule.displayName ? { name: rule.displayName } : {}),
    enabled: rule.isEnabled !== false,
    conditions: {
      from: [
        ...addressesOf(conditions.fromAddresses),
        ...(conditions.senderContains ?? []),
      ],
      to: [
        ...addressesOf(conditions.sentToAddresses),
        ...(conditions.recipientContains ?? []),
      ],
      subject: conditions.subjectContains ?? [],
      words: conditions.bodyOrSubjectContains ?? [],
      notWords: exceptions.bodyOrSubjectContains ?? [],
      hasAttachment: conditions.hasAttachments === true,
      ...(size ? { size } : {}),
    },
    actions: filterActions,
    more,
    ...(rule.hasError
      ? { problem: "error" as const }
      : rule.isReadOnly
        ? { problem: "readOnly" as const }
        : {}),
  };
}

/** `object` without the keys action0 shows (what it keeps of a rule). */
function unknownPart(
  object: Readonly<Record<string, unknown>> | null | undefined,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object ?? {}).filter(([key]) => !known.has(key)),
  );
}

/**
 * A spec's conditions, exceptions and actions in Graph's terms, merged
 * with what `original` has that action0 doesn't show. Graph replaces each
 * of the three objects as a whole, so they're always sent complete.
 */
export function toGraphRule(
  spec: FilterSpec,
  original?: GraphMessageRule,
): Required<Pick<GraphMessageRule, "conditions" | "exceptions" | "actions">> {
  const { conditions, actions } = spec;
  const keptConditions: Record<string, unknown> = unknownPart(
    original?.conditions,
    KNOWN_CONDITIONS,
  );
  // A real size range (not "larger" or "smaller") isn't shown: keep it.
  const range = original?.conditions?.withinSizeRange;
  if (range && !sizeOf(range) && !conditions.size)
    keptConditions.withinSizeRange = range;
  const split = (values: readonly string[]) => ({
    addresses: values.filter(isAddress),
    parts: values.filter((value) => !isAddress(value)),
  });
  const from = split(conditions.from);
  const to = split(conditions.to);
  const graphConditions: GraphRulePredicates = {
    ...keptConditions,
    ...(from.addresses.length > 0
      ? { fromAddresses: recipients(from.addresses) }
      : {}),
    ...(from.parts.length > 0 ? { senderContains: from.parts } : {}),
    ...(to.addresses.length > 0
      ? { sentToAddresses: recipients(to.addresses) }
      : {}),
    ...(to.parts.length > 0 ? { recipientContains: to.parts } : {}),
    ...(conditions.subject.length > 0
      ? { subjectContains: [...conditions.subject] }
      : {}),
    ...(conditions.words.length > 0
      ? { bodyOrSubjectContains: [...conditions.words] }
      : {}),
    ...(conditions.hasAttachment ? { hasAttachments: true } : {}),
    ...(conditions.size
      ? {
          withinSizeRange:
            conditions.size.compare === "larger"
              ? {
                  minimumSize: Math.ceil(conditions.size.bytes / 1024),
                  maximumSize: OPEN_MAX_KB,
                }
              : {
                  minimumSize: 0,
                  maximumSize: Math.floor(conditions.size.bytes / 1024),
                },
        }
      : {}),
  };
  const graphExceptions: GraphRulePredicates = {
    ...unknownPart(original?.exceptions, KNOWN_EXCEPTIONS),
    ...(conditions.notWords.length > 0
      ? { bodyOrSubjectContains: [...conditions.notWords] }
      : {}),
  };
  const categories = actions.labels.flatMap((id) => {
    const name = categoryName(id);
    return name === undefined ? [] : [name];
  });
  const graphActions: GraphRuleActions = {
    ...unknownPart(original?.actions, KNOWN_ACTIONS),
    ...(actions.moveTo ? { moveToFolder: actions.moveTo } : {}),
    ...(categories.length > 0 ? { assignCategories: categories } : {}),
    ...(actions.markRead ? { markAsRead: true } : {}),
    ...(actions.forwardTo.length > 0
      ? { forwardTo: recipients(actions.forwardTo) }
      : {}),
    ...(actions.trash ? { delete: true } : {}),
    ...(actions.stop ? { stopProcessingRules: true } : {}),
  };
  return {
    conditions: graphConditions,
    exceptions: graphExceptions,
    actions: graphActions,
  };
}

/**
 * A name for a rule the user didn't name (Outlook requires one): its
 * first condition's value, as Outlook's own suggestions do.
 */
export function ruleName(spec: FilterSpec): string {
  const { from, subject, to, words } = spec.conditions;
  const first = [...from, ...subject, ...to, ...words][0];
  return (spec.name?.trim() || first?.trim() || "action0").slice(0, 255);
}

/** A KQL value: quoted when it has spaces or KQL's own characters. */
function kqlValue(value: string): string {
  const plain = value.replace(/"/g, "").trim();
  return /[\s:()]/.test(plain) ? `"${plain}"` : plain;
}

/**
 * The search (KQL, as Graph's `$search` takes it) for mail the conditions
 * match; the provider quotes the whole of it.
 */
export function graphSearchOf(conditions: FilterConditions): string {
  const anyOf = (terms: readonly string[]) =>
    terms.length === 1 ? (terms[0] ?? "") : `(${terms.join(" OR ")})`;
  const on = (property: string, values: readonly string[]) =>
    anyOf(values.map((value) => `${property}:${kqlValue(value)}`));
  const text = (values: readonly string[]) =>
    anyOf(
      values.flatMap((value) => [
        `subject:${kqlValue(value)}`,
        `body:${kqlValue(value)}`,
      ]),
    );
  const parts: string[] = [];
  if (conditions.from.length > 0) parts.push(on("from", conditions.from));
  if (conditions.to.length > 0) parts.push(on("recipients", conditions.to));
  if (conditions.subject.length > 0)
    parts.push(on("subject", conditions.subject));
  if (conditions.words.length > 0) parts.push(text(conditions.words));
  if (conditions.hasAttachment) parts.push("hasAttachments:true");
  if (conditions.size)
    parts.push(
      `size${conditions.size.compare === "larger" ? ">" : "<"}${String(conditions.size.bytes)}`,
    );
  const positive = parts.join(" AND ");
  if (conditions.notWords.length === 0) return positive;
  const negative = `NOT ${text(conditions.notWords)}`;
  return positive === "" ? negative : `${positive} AND ${negative}`;
}

/** A local day's start as Graph's UTC time. */
function utc(instant: number): GraphDateTime {
  return {
    dateTime: new Date(instant).toISOString().slice(0, 19),
    timeZone: "UTC",
  };
}

/** The instant of a Graph time (UTC, a Windows or an IANA zone). */
function instantOf(time: GraphDateTime): number {
  const [date = "", clock = "00:00:00"] = time.dateTime.split("T");
  const hms = clock.slice(0, 8);
  const zone = time.timeZone;
  if (/^(UTC|Etc\/UTC|Coordinated Universal Time)$/i.test(zone))
    return Date.parse(`${date}T${hms}Z`);
  const iana = ianaZone(zone);
  return iana === undefined
    ? Date.parse(`${date}T${hms}Z`)
    : instantAt(date, hms.slice(0, 5), iana);
}

/** Outlook's automatic replies in the domain model. */
export function toAutoReply(
  setting: GraphAutomaticReplies,
  personal: boolean,
): AutoReply {
  const start = setting.scheduledStartDateTime;
  const end = setting.scheduledEndDateTime;
  const scheduled = setting.status === "scheduled" && start && end;
  const startMs = scheduled ? instantOf(start) : 0;
  const endMs = scheduled ? instantOf(end) : 0;
  const internal = setting.internalReplyMessage ?? "";
  const external = setting.externalReplyMessage ?? "";
  const audience = setting.externalAudience ?? "all";
  return {
    enabled:
      setting.status === "alwaysEnabled" || setting.status === "scheduled",
    ...(scheduled ? { start: dayOf(startMs) } : {}),
    ...(scheduled && endMs - startMs < OPEN_END_MIN_MS
      ? { end: lastDayOf(endMs) }
      : {}),
    subject: "",
    text: personal ? internal || external : internal,
    contactsOnly: personal && audience === "contactsOnly",
    ...(personal
      ? {}
      : {
          outside: {
            audience: audience === "contactsOnly" ? "contacts" : audience,
            text: external,
          },
        }),
  };
}

/**
 * An automatic reply as Outlook's settings. A first or last day makes it
 * "scheduled", which needs both: a missing first day is today, a missing
 * last day {@link OPEN_END_DAYS} after the first.
 */
export function toAutomaticReplies(
  reply: AutoReply,
  personal: boolean,
): GraphAutomaticReplies {
  const scheduled =
    reply.enabled && (reply.start !== undefined || reply.end !== undefined);
  const start = startOfDay(reply.start ?? dayOf(Date.now()));
  const end =
    reply.end === undefined
      ? start + OPEN_END_DAYS * 86_400_000
      : endOfDay(reply.end);
  const outside = reply.outside;
  return {
    status: !reply.enabled
      ? "disabled"
      : scheduled
        ? "scheduled"
        : "alwaysEnabled",
    ...(personal
      ? {
          internalReplyMessage: reply.text,
          externalReplyMessage: reply.text,
          externalAudience: reply.contactsOnly ? "contactsOnly" : "all",
        }
      : {
          internalReplyMessage: reply.text,
          externalReplyMessage: outside?.text ?? reply.text,
          externalAudience:
            outside?.audience === "contacts"
              ? "contactsOnly"
              : (outside?.audience ?? "all"),
        }),
    ...(scheduled
      ? {
          scheduledStartDateTime: utc(start),
          scheduledEndDateTime: utc(end),
        }
      : {}),
  };
}

/**
 * Outlook inbox rules (`mailFolders/inbox/messageRules`) and automatic
 * replies (`mailboxSettings`), both with `MailboxSettings.ReadWrite`.
 * Rules run in their `sequence` order and have names and an on/off switch.
 */
export class GraphFilterProvider implements FilterProvider {
  readonly #http: GraphHttp;
  readonly #personal: boolean;

  constructor(http: GraphHttp, options: { readonly personal?: boolean } = {}) {
    this.#http = http;
    this.#personal = options.personal === true;
  }

  async load(signal?: AbortSignal): Promise<FilterSetup> {
    const [rules, autoReply] = await Promise.all([
      this.#rules(signal),
      this.autoReply(signal),
    ]);
    return {
      capabilities: this.#capabilities(),
      filters: rules.map(toMailFilter),
      autoReply,
    };
  }

  async autoReply(signal?: AbortSignal): Promise<AutoReply> {
    await loadZones();
    const settings = await this.#http.get<{
      automaticRepliesSetting?: GraphAutomaticReplies;
    }>("me/mailboxSettings", { $select: "automaticRepliesSetting" }, signal);
    return toAutoReply(settings.automaticRepliesSetting ?? {}, this.#personal);
  }

  async create(
    spec: FilterSpec,
    position?: number,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    const rules = await this.#rules(signal);
    const last = rules.reduce(
      (max, rule) => Math.max(max, rule.sequence ?? 0),
      0,
    );
    const { conditions, exceptions, actions } = toGraphRule(spec);
    const created = await this.#http.post<GraphMessageRule>(
      RULES,
      {
        displayName: ruleName(spec),
        sequence: last + 1,
        isEnabled: spec.enabled,
        conditions,
        ...(Object.keys(exceptions ?? {}).length > 0 ? { exceptions } : {}),
        actions,
      },
      { retry: false, ...(signal ? { signal } : {}) },
    );
    if (position !== undefined && position < rules.length) {
      const ids = rules.map((rule) => rule.id);
      ids.splice(position, 0, created.id);
      await this.#renumber(ids, [...rules, created], signal);
      return toMailFilter({ ...created, sequence: position + 1 });
    }
    return toMailFilter(created);
  }

  async update(
    id: FilterId,
    spec: FilterSpec,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    const path = `${RULES}/${encodeURIComponent(id)}`;
    const original = await this.#http.get<GraphMessageRule>(
      path,
      undefined,
      signal,
    );
    const changed = await this.#http.patch<GraphMessageRule>(
      path,
      {
        displayName:
          spec.name?.trim() || original.displayName || ruleName(spec),
        isEnabled: spec.enabled,
        ...toGraphRule(spec, original),
      },
      signal,
    );
    return toMailFilter(changed);
  }

  async setEnabled(
    id: FilterId,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#http.patch(
      `${RULES}/${encodeURIComponent(id)}`,
      { isEnabled: enabled },
      signal,
    );
  }

  async reorder(ids: readonly FilterId[], signal?: AbortSignal): Promise<void> {
    await this.#renumber(ids, await this.#rules(signal), signal);
  }

  async remove(id: FilterId, signal?: AbortSignal): Promise<void> {
    await this.#http.delete(`${RULES}/${encodeURIComponent(id)}`, signal);
  }

  async setAutoReply(reply: AutoReply, signal?: AbortSignal): Promise<void> {
    await this.#http.patch(
      "me/mailboxSettings",
      { automaticRepliesSetting: toAutomaticReplies(reply, this.#personal) },
      signal,
    );
  }

  searchOf(conditions: FilterConditions): string {
    return graphSearchOf(conditions);
  }

  #capabilities(): FilterCapabilities {
    return {
      conditions: [
        "from",
        "to",
        "subject",
        "words",
        "notWords",
        "hasAttachment",
        "size",
      ],
      actions: ["moveTo", "labels", "markRead", "forwardTo", "trash", "stop"],
      names: true,
      toggle: true,
      order: true,
      forward: "any",
      maxForward: 10,
      scope: "inbox",
      autoReply: {
        subject: false,
        html: true,
        schedule: true,
        contactsOnly: this.#personal,
        outside: !this.#personal,
      },
    };
  }

  /** The rules in the order they run. */
  async #rules(signal?: AbortSignal): Promise<GraphMessageRule[]> {
    const page = await this.#http.get<{ value?: GraphMessageRule[] }>(
      RULES,
      undefined,
      signal,
    );
    return [...(page.value ?? [])].sort(
      (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
    );
  }

  /**
   * Gives the rules `ids` the sequence 1, 2, … in that order (only those
   * whose number changes); rules not in `ids` follow after them.
   */
  async #renumber(
    ids: readonly string[],
    rules: readonly GraphMessageRule[],
    signal?: AbortSignal,
  ): Promise<void> {
    const order = [
      ...ids,
      ...rules.map((rule) => rule.id).filter((id) => !ids.includes(id)),
    ];
    const sequenceOf = new Map(rules.map((rule) => [rule.id, rule.sequence]));
    await Promise.all(
      order.flatMap((id, index) =>
        sequenceOf.has(id) && sequenceOf.get(id) !== index + 1
          ? [
              this.#http.patch(
                `${RULES}/${encodeURIComponent(id)}`,
                { sequence: index + 1 },
                signal,
              ),
            ]
          : [],
      ),
    );
  }
}
