import { MailError } from "../../core/errors";
import {
  asFilterId,
  type AutoReply,
  type FilterCapabilities,
  type FilterConditions,
  type FilterId,
  type FilterProvider,
  type FilterSetup,
  type FilterSpec,
  type MailFilter,
} from "../../core/filters";
import { sleep } from "../../lib/sleep";

/** What a demo account's filters start as. */
export interface FakeFilterData {
  /** Whose filters it imitates: Gmail's (no names, order or switch) or Outlook's. */
  readonly flavor: "gmail" | "outlook";
  readonly filters: readonly MailFilter[];
  readonly autoReply: AutoReply;
  /** Gmail: verified forwarding addresses. */
  readonly forwardAddresses?: readonly string[];
}

/** Options of {@link FakeFilterProvider}. */
export interface FakeFilterProviderOptions {
  /** Simulated latency per call. */
  readonly latencyMs?: number;
}

/** What Gmail's filters can do. */
const GMAIL: FilterCapabilities = {
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

/** What Outlook's rules (a work account) can do. */
const OUTLOOK: FilterCapabilities = {
  conditions: GMAIL.conditions,
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
    contactsOnly: false,
    outside: true,
  },
};

/**
 * In-memory filters and automatic reply of a demo account. Like the real
 * ones they live "on the server": they don't act on the demo's mail.
 */
export class FakeFilterProvider implements FilterProvider {
  readonly #flavor: "gmail" | "outlook";
  readonly #latencyMs: number;
  readonly #forwardAddresses: readonly string[] | undefined;
  #filters: readonly MailFilter[];
  #autoReply: AutoReply;
  #nextId = 1;
  /** Set to make every change fail (tests). */
  failWrites = false;
  /** Set to load the filters read-only, as without Gmail's settings permission (tests). */
  readOnly = false;

  constructor(data: FakeFilterData, options: FakeFilterProviderOptions = {}) {
    this.#flavor = data.flavor;
    this.#filters = data.filters;
    this.#autoReply = data.autoReply;
    this.#forwardAddresses = data.forwardAddresses;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async load(signal?: AbortSignal): Promise<FilterSetup> {
    await this.#delay(signal);
    return {
      capabilities: this.#flavor === "gmail" ? GMAIL : OUTLOOK,
      filters: this.#filters,
      autoReply: this.#autoReply,
      ...(this.#forwardAddresses
        ? { forwardAddresses: this.#forwardAddresses }
        : {}),
      ...(this.readOnly ? { readOnly: "permission" as const } : {}),
    };
  }

  async autoReply(signal?: AbortSignal): Promise<AutoReply> {
    await this.#delay(signal);
    return this.#autoReply;
  }

  async create(
    spec: FilterSpec,
    position?: number,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    await this.#refuseIfFailing(signal);
    const filter = this.#filterOf(asFilterId(`f${String(this.#nextId++)}`), {
      ...spec,
      more: false,
    });
    const at =
      position === undefined || this.#flavor === "gmail"
        ? this.#filters.length
        : Math.min(Math.max(position, 0), this.#filters.length);
    this.#filters = [
      ...this.#filters.slice(0, at),
      filter,
      ...this.#filters.slice(at),
    ];
    return filter;
  }

  async update(
    id: FilterId,
    spec: FilterSpec,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    await this.#refuseIfFailing(signal);
    const before = this.#find(id);
    // Like Gmail, which can't change a filter: a new one in its place.
    const next = this.#filterOf(
      this.#flavor === "gmail" ? asFilterId(`f${String(this.#nextId++)}`) : id,
      { ...spec, more: before.more },
    );
    this.#filters = this.#filters.map((filter) =>
      filter.id === id ? next : filter,
    );
    return next;
  }

  async setEnabled(
    id: FilterId,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.#find(id);
    this.#filters = this.#filters.map((filter) =>
      filter.id === id ? { ...filter, enabled } : filter,
    );
  }

  async reorder(ids: readonly FilterId[], signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.#filters = ids.map((id) => this.#find(id));
  }

  async remove(id: FilterId, signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.#find(id);
    this.#filters = this.#filters.filter((filter) => filter.id !== id);
  }

  async setAutoReply(reply: AutoReply, signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.#autoReply = reply;
  }

  /** The demo searches words only: the first value of each condition. */
  searchOf(conditions: FilterConditions): string {
    return [
      conditions.from[0],
      conditions.to[0],
      conditions.subject[0],
      conditions.words[0],
    ]
      .filter((word): word is string => word !== undefined && word !== "")
      .join(" ");
  }

  #filterOf(
    id: FilterId,
    spec: FilterSpec & { readonly more: boolean },
  ): MailFilter {
    const { name, ...rest } = spec;
    return {
      id,
      ...rest,
      ...(this.#flavor === "outlook"
        ? { name: name?.trim() || generatedName(spec.conditions) }
        : {}),
      ...(this.#flavor === "gmail" ? { enabled: true } : {}),
    };
  }

  #find(id: FilterId): MailFilter {
    const filter = this.#filters.find((candidate) => candidate.id === id);
    if (!filter)
      throw new MailError("not-found", `No filter ${id}`, { status: 404 });
    return filter;
  }

  async #delay(signal?: AbortSignal) {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
    signal?.throwIfAborted();
  }

  async #refuseIfFailing(signal?: AbortSignal) {
    await this.#delay(signal);
    if (this.failWrites)
      throw new MailError("provider", "The demo server refused the change.", {
        status: 500,
        reason: "demoRefused",
      });
    if (this.readOnly)
      throw new MailError(
        "unavailable",
        "Changing the demo's settings isn't allowed.",
        { status: 403, reason: "settingsNotAllowed" },
      );
  }
}

/** A name for a rule that has none, like Outlook's own. */
function generatedName(conditions: FilterConditions): string {
  return (
    conditions.from[0] ??
    conditions.subject[0] ??
    conditions.to[0] ??
    conditions.words[0] ??
    "Rule"
  );
}
