import { isMailServerError } from "../../accounts/mailServer";
import { MailError } from "../../core/errors";
import {
  NO_ACTIONS,
  NO_CONDITIONS,
  asFilterId,
  type AutoReply,
  type FilterAction,
  type FilterCapabilities,
  type FilterCondition,
  type FilterConditions,
  type FilterId,
  type FilterProvider,
  type FilterServerSettings,
  type FilterSetup,
  type FilterSpec,
  type MailFilter,
} from "../../core/filters";
import type { Mailbox } from "../../core/model";
import { toMailError } from "../imap/mappers";
import type { SieveBridge, SieveScript } from "./bridge";
import {
  SieveSyntaxError,
  autoReplyOf,
  filterChunks,
  folderName,
  insertFilter,
  parseScript,
  removeFilter,
  reorderFilters,
  replaceFilter,
  ruleOf,
  ruleText,
  setVacation,
  toggledCustom,
  vacationOf,
  vacationText,
  withRequires,
  type FilterChunk,
  type SieveDocument,
} from "./script";

/** Options of {@link SieveFilterProvider}. */
export interface SieveFilterProviderOptions {
  readonly bridge: SieveBridge;
  /** The mail server account, `imap:<address>`. */
  readonly key: string;
  /** The mail server's host, for messages. */
  readonly service: string;
  /** The account's From addresses (the automatic reply answers mail to them). */
  readonly addresses: () => Promise<readonly string[]>;
  /** The account's folders (IMAP ids, `f:<path>`), for the Trash folder. */
  readonly mailboxes: () => Promise<readonly Mailbox[]>;
}

/**
 * Most forwarding addresses per rule: Dovecot's `sieve_max_redirects`
 * defaults to 4.
 */
const MAX_FORWARD = 4;

/** What the server's Sieve extensions allow. */
export function sieveCapabilities(
  extensions: readonly string[],
  hasTrash: boolean,
): FilterCapabilities {
  const has = new Set(extensions.map((e) => e.toLowerCase()));
  const conditions: FilterCondition[] = [
    "from",
    "to",
    "subject",
    ...(has.has("body") ? (["words", "notWords"] as const) : []),
    ...(has.has("mime") ? (["hasAttachment"] as const) : []),
    "size",
  ];
  const actions: FilterAction[] = [
    ...(has.has("fileinto") ? (["moveTo"] as const) : []),
    ...(has.has("imap4flags") ? (["markRead", "star"] as const) : []),
    ...(has.has("copy") ? (["forwardTo"] as const) : []),
    ...(has.has("fileinto") && hasTrash ? (["trash"] as const) : []),
    "stop",
  ];
  return {
    conditions,
    actions,
    names: true,
    toggle: true,
    order: true,
    ...(has.has("copy") ? { forward: "any" as const } : {}),
    maxForward: has.has("copy") ? MAX_FORWARD : 0,
    scope: "inbox",
    ...(has.has("vacation")
      ? {
          autoReply: {
            subject: true,
            html: false,
            schedule: has.has("date") && has.has("relational"),
            contactsOnly: false,
            outside: false,
          },
        }
      : {}),
  };
}

/** A short, stable fingerprint of a rule's text (FNV-1a). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A filter's id: its place among the rules and what it says, so a stale id never edits another rule. */
const idOf = (chunk: FilterChunk, position: number): FilterId =>
  asFilterId(`${position}:${fingerprint(chunk.text)}`);

function toFilter(chunk: FilterChunk, position: number): MailFilter {
  const id = idOf(chunk, position);
  if (chunk.kind === "custom")
    return {
      id,
      ...(chunk.name ? { name: chunk.name } : {}),
      enabled: chunk.enabled,
      conditions: NO_CONDITIONS,
      actions: NO_ACTIONS,
      more: false,
      custom: chunk.code,
    };
  const { rule } = chunk;
  return {
    id,
    ...(rule.name ? { name: rule.name } : {}),
    enabled: rule.enabled,
    conditions: rule.conditions,
    actions: rule.actions,
    more: rule.extras.length > 0,
  };
}

/** Words for a search: bare, or quoted when they have spaces (quotes can't be searched). */
function searchValue(value: string): string {
  const clean = value.replace(/"/g, "").trim();
  return /[\s:]/.test(clean) || clean.startsWith("-") ? `"${clean}"` : clean;
}

/**
 * Filters kept in a Sieve script on the mail server (ManageSieve, the
 * apps only). Rules are read and written in the active script, in place:
 * see `script.ts`. Every change reads the script first and writes it only
 * if the server still has that text, so changes made elsewhere meanwhile
 * aren't lost (`filtersChanged`).
 */
export class SieveFilterProvider implements FilterProvider {
  readonly #options: SieveFilterProviderOptions;

  constructor(options: SieveFilterProviderOptions) {
    this.#options = options;
  }

  readonly filterServer: FilterServerSettings = {
    current: async () => {
      const { bridge, key } = this.#options;
      try {
        const known = await bridge.known(key);
        return known
          ? { host: known.host, port: known.port, chosen: known.chosen }
          : undefined;
      } catch (error) {
        throw this.#error(error);
      }
    },
    choose: async (server) => {
      const { bridge, key } = this.#options;
      try {
        await bridge.setServer(
          key,
          server ? { host: server.host, port: server.port } : null,
        );
      } catch (error) {
        throw this.#error(error);
      }
    },
  };

  async load(signal?: AbortSignal): Promise<FilterSetup> {
    const { bridge, key, service } = this.#options;
    try {
      await bridge.find(key);
    } catch (error) {
      if (isMailServerError(error) && error.kind === "notFound")
        throw new MailError("unavailable", error.message, {
          cause: error,
          reason: "noFilterServer",
          params: { service },
        });
      throw this.#error(error);
    }
    signal?.throwIfAborted();
    const { script, document, trash } = await this.#read();
    return {
      capabilities: sieveCapabilities(script.extensions, trash !== undefined),
      filters: filterChunks(document).map(toFilter),
      autoReply: autoReplyOf(document),
    };
  }

  async autoReply(signal?: AbortSignal): Promise<AutoReply | undefined> {
    const { bridge, key } = this.#options;
    const known = await bridge.known(key).catch((error: unknown) => {
      throw this.#error(error);
    });
    if (!known) return undefined;
    signal?.throwIfAborted();
    const script = await this.#script();
    try {
      return autoReplyOf(parseScript(script.script));
    } catch (error) {
      if (error instanceof SieveSyntaxError) return undefined;
      throw error;
    }
  }

  async create(
    spec: FilterSpec,
    position?: number,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    const next = await this.#change(signal, (document, trash) => {
      const rule = ruleOf(spec);
      const { text, needs } = ruleText(rule, document.eol, { trash });
      return withRequires(
        insertFilter(document, position, { kind: "rule", text, rule }),
        needs,
      );
    });
    const filters = filterChunks(next);
    const at =
      position === undefined
        ? filters.length - 1
        : Math.min(Math.max(0, position), filters.length - 1);
    const chunk = filters[at];
    if (!chunk) throw this.#changed();
    return toFilter(chunk, at);
  }

  async update(
    id: FilterId,
    spec: FilterSpec,
    signal?: AbortSignal,
  ): Promise<MailFilter> {
    let at = 0;
    const next = await this.#change(signal, (document, trash) => {
      at = this.#locate(document, id);
      const chunk = filterChunks(document)[at];
      if (chunk?.kind !== "rule")
        throw new MailError(
          "provider",
          "This rule is written in Sieve code action0 can’t show; it can only be switched on or off or deleted.",
        );
      const rule = ruleOf(spec, chunk.rule);
      const { text, needs } = ruleText(rule, document.eol, { trash });
      return withRequires(
        replaceFilter(document, at, { kind: "rule", text, rule }),
        needs,
      );
    });
    const chunk = filterChunks(next)[at];
    if (!chunk) throw this.#changed();
    return toFilter(chunk, at);
  }

  async setEnabled(
    id: FilterId,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#change(signal, (document, trash) => {
      const at = this.#locate(document, id);
      const chunk = filterChunks(document)[at];
      if (chunk?.kind === "rule") {
        const rule = { ...chunk.rule, enabled };
        const { text } = ruleText(rule, document.eol, { trash });
        return replaceFilter(document, at, { kind: "rule", text, rule });
      }
      if (!chunk) throw this.#changed();
      const text = toggledCustom(chunk, enabled, document.eol);
      if (text === undefined)
        throw new MailError(
          "provider",
          "This rule was switched off without its condition (if false), so it can’t be switched on again here.",
        );
      // Read again after writing, so only the text matters here.
      return replaceFilter(document, at, { ...chunk, text, enabled });
    });
  }

  async reorder(ids: readonly FilterId[], signal?: AbortSignal): Promise<void> {
    await this.#change(signal, (document) => {
      const order = ids.map((id) => this.#locate(document, id));
      const all = filterChunks(document).length;
      if (order.length !== all || new Set(order).size !== all)
        throw this.#changed();
      return reorderFilters(document, order);
    });
  }

  async remove(id: FilterId, signal?: AbortSignal): Promise<void> {
    await this.#change(signal, (document) =>
      removeFilter(document, this.#locate(document, id)),
    );
  }

  async setAutoReply(reply: AutoReply, signal?: AbortSignal): Promise<void> {
    const addresses = await this.#options.addresses();
    await this.#change(signal, (document, _trash, extensions) => {
      const capabilities = sieveCapabilities(extensions, false).autoReply;
      if (!capabilities)
        throw new MailError(
          "unavailable",
          "This mail server can’t send automatic replies (Sieve vacation).",
        );
      const old = vacationOf(document);
      if (!old && !reply.enabled) return document;
      const vacation = {
        ...(old?.name ? { name: old.name } : {}),
        enabled: reply.enabled,
        ...(capabilities.schedule && reply.start !== undefined
          ? { start: reply.start }
          : {}),
        ...(capabilities.schedule && reply.end !== undefined
          ? { end: reply.end }
          : {}),
        subject: reply.subject,
        text: reply.text,
        ...(old?.days === undefined ? {} : { days: old.days }),
        keep: old?.keep ?? [],
      };
      const { text, needs } = vacationText(vacation, addresses, document.eol);
      return withRequires(setVacation(document, text, vacation), needs);
    });
  }

  searchOf(conditions: FilterConditions): string {
    // IMAP's search ANDs its terms, so a field with several values (any of
    // them) searches for the first: it may find fewer, never more.
    const terms: string[] = [];
    const [from] = conditions.from;
    const [to] = conditions.to;
    const [subject] = conditions.subject;
    const [word] = conditions.words;
    if (from) terms.push(`from:${searchValue(from)}`);
    if (to) terms.push(`to:${searchValue(to)}`);
    if (subject) terms.push(`subject:${searchValue(subject)}`);
    if (word) terms.push(searchValue(word));
    for (const notWord of conditions.notWords)
      terms.push(`-${searchValue(notWord)}`);
    if (conditions.size)
      terms.push(
        `${conditions.size.compare === "larger" ? "larger" : "smaller"}:${conditions.size.bytes}`,
      );
    return terms.join(" ");
  }

  /** The `position` of the filter `id` names, or `filtersChanged`. */
  #locate(document: SieveDocument, id: FilterId): number {
    const [place] = id.split(":");
    const position = Number(place);
    const chunk = filterChunks(document)[position];
    if (!chunk || idOf(chunk, position) !== id) throw this.#changed();
    return position;
  }

  /** Reads the script, changes it and writes it if nobody else did meanwhile. */
  async #change(
    signal: AbortSignal | undefined,
    change: (
      document: SieveDocument,
      trash: string | undefined,
      extensions: readonly string[],
    ) => SieveDocument,
  ): Promise<SieveDocument> {
    const { script, document, trash } = await this.#read();
    const next = change(document, trash, script.extensions);
    signal?.throwIfAborted();
    const text = next.chunks.map((chunk) => chunk.text).join("");
    if (text === script.script) return next;
    try {
      await this.#options.bridge.write(this.#options.key, {
        name: script.name ?? "action0",
        script: text,
        expected: script.script,
        activate: script.name === undefined,
      });
    } catch (error) {
      throw this.#error(error);
    }
    return parseScript(text, trash === undefined ? {} : { trash });
  }

  async #read(): Promise<{
    script: SieveScript;
    document: SieveDocument;
    trash: string | undefined;
  }> {
    const [script, trash] = await Promise.all([this.#script(), this.#trash()]);
    try {
      return {
        script,
        document: parseScript(
          script.script,
          trash === undefined ? {} : { trash },
        ),
        trash,
      };
    } catch (error) {
      if (error instanceof SieveSyntaxError)
        throw new MailError(
          "provider",
          `action0 can’t read the filter script on ${this.#options.service} (${error.message}).`,
          { cause: error },
        );
      throw error;
    }
  }

  async #script(): Promise<SieveScript> {
    try {
      return await this.#options.bridge.read(this.#options.key);
    } catch (error) {
      throw this.#error(error);
    }
  }

  async #trash(): Promise<string | undefined> {
    const mailboxes = await this.#options.mailboxes();
    const trash = mailboxes.find((mailbox) => mailbox.role === "trash");
    return trash ? folderName(trash.id) : undefined;
  }

  #changed(): MailError {
    return new MailError(
      "provider",
      "The filters were changed somewhere else meanwhile.",
      { reason: "filtersChanged" },
    );
  }

  #error(error: unknown): unknown {
    return toMailError(error, { service: this.#options.service });
  }
}
