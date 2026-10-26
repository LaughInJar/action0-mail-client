import { isValidAddress } from "../core/addresses";
import { MailError } from "../core/errors";
import type { EmailAddress, Sender } from "../core/model";
import type { SenderSettings } from "../core/provider";
import { readJson, writeJson } from "../lib/storage";

/** The account's own address, as the provider knows it. */
export interface OwnAddress {
  readonly address: string;
  readonly name?: string;
}

/** localStorage key of an account's signatures. */
export function signaturesKey(accountId: string): string {
  return `a0.settings.signatures.${accountId}`;
}

/** localStorage key of an account's From addresses and catch-all domains. */
export function sendersKey(accountId: string): string {
  return `a0.settings.senders.${accountId}`;
}

/** What's kept under {@link sendersKey}. */
interface Stored {
  readonly senders: readonly SenderSettings[];
  readonly catchAll: readonly string[];
}

/**
 * From addresses, their signatures and catch-all domains, kept in this
 * browser (localStorage) for accounts whose provider can't list or store
 * them (IMAP, Microsoft Graph). The account's own address is always there,
 * first, and can't be removed.
 */
export class SenderStore {
  readonly #storage: Storage | undefined;
  readonly #accountId: string;

  constructor(storage: Storage | undefined, accountId: string) {
    this.#storage = storage;
    this.#accountId = accountId;
  }

  /** The own address, then the added ones; exactly one is the default. */
  list(own: OwnAddress): Sender[] {
    const { senders } = this.#stored();
    const signatures = this.#signatures();
    const ownKey = own.address.toLowerCase();
    const ownSettings = senders.find((s) => s.address.toLowerCase() === ownKey);
    const all: SenderSettings[] = [
      {
        ...ownSettings,
        address: own.address,
        ...(ownSettings?.name || own.name
          ? { name: ownSettings?.name ?? own.name }
          : {}),
        isDefault: ownSettings?.isDefault ?? false,
      },
      ...senders.filter((s) => s.address.toLowerCase() !== ownKey),
    ];
    const defaultIndex = Math.max(
      0,
      all.findIndex((s) => s.isDefault),
    );
    return all.map(({ address, name, replyTo, bccSelf }, index) => ({
      address,
      ...(name ? { name } : {}),
      isDefault: index === defaultIndex,
      signature: signatures[address.toLowerCase()] ?? "",
      ...(replyTo ? { replyTo } : {}),
      ...(bccSelf ? { bccSelf } : {}),
    }));
  }

  /**
   * Replaces the addresses (the own one is kept even if missing) and the
   * catch-all domains; only domains of the addresses are kept. Signatures
   * of removed addresses go too.
   */
  save(
    own: OwnAddress,
    senders: readonly SenderSettings[],
    catchAll: readonly string[],
  ): void {
    const seen = new Set<string>();
    for (const { address, replyTo } of senders) {
      const key = address.toLowerCase();
      if (!isValidAddress(address) || seen.has(key))
        throw new MailError("provider", `Not a new address: ${address}`);
      if (replyTo && !isValidAddress(replyTo.address))
        throw new MailError("provider", `Not an address: ${replyTo.address}`);
      seen.add(key);
    }
    const ownKey = own.address.toLowerCase();
    const list = seen.has(ownKey)
      ? senders
      : [{ address: own.address, isDefault: false }, ...senders];
    const defaultIndex = Math.max(
      0,
      list.findIndex((s) => s.isDefault),
    );
    const domains = new Set(list.map((s) => domainOf(s.address)));
    writeJson(this.#storage, sendersKey(this.#accountId), {
      senders: list.map(({ name, ...sender }, index) => ({
        ...sender,
        // The own address follows the account's name unless changed here.
        ...(name &&
        !(sender.address.toLowerCase() === ownKey && name === own.name)
          ? { name }
          : {}),
        isDefault: index === defaultIndex,
      })),
      catchAll: [
        ...new Set(catchAll.map((domain) => domain.trim().toLowerCase())),
      ].filter((domain) => domains.has(domain)),
    } satisfies Stored);
    const signatures = this.#signatures();
    writeJson(
      this.#storage,
      signaturesKey(this.#accountId),
      Object.fromEntries(
        [...seen, ownKey].flatMap((key) =>
          signatures[key] === undefined ? [] : [[key, signatures[key]]],
        ),
      ),
    );
  }

  /** Domains whose every address is the user's. */
  catchAll(): readonly string[] {
    return this.#stored().catchAll;
  }

  updateSignature(address: string, html: string): void {
    writeJson(this.#storage, signaturesKey(this.#accountId), {
      ...this.#signatures(),
      [address.toLowerCase()]: html,
    });
  }

  #signatures(): Readonly<Record<string, string>> {
    const stored = readJson(this.#storage, signaturesKey(this.#accountId));
    if (typeof stored !== "object" || stored === null) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  #stored(): Stored {
    const stored = readJson(this.#storage, sendersKey(this.#accountId));
    if (typeof stored !== "object" || stored === null)
      return { senders: [], catchAll: [] };
    const { senders, catchAll } = stored as Partial<
      Record<keyof Stored, unknown>
    >;
    return {
      senders: Array.isArray(senders) ? senders.flatMap(toSettings) : [],
      catchAll: Array.isArray(catchAll)
        ? catchAll.filter((d): d is string => typeof d === "string")
        : [],
    };
  }
}

/** The part after the `@`, lower case. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function toSettings(value: unknown): SenderSettings[] {
  if (typeof value !== "object" || value === null) return [];
  const { address, name, replyTo, bccSelf, isDefault } = value as Record<
    string,
    unknown
  >;
  if (typeof address !== "string") return [];
  const reply = toAddress(replyTo);
  return [
    {
      address,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(reply ? { replyTo: reply } : {}),
      ...(bccSelf === true ? { bccSelf } : {}),
      isDefault: isDefault === true,
    },
  ];
}

function toAddress(value: unknown): EmailAddress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { address, name } = value as Record<string, unknown>;
  if (typeof address !== "string") return undefined;
  return typeof name === "string" && name ? { name, address } : { address };
}
