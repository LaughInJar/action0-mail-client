import type {
  MailServerAccountInfo,
  MailServerSetup,
} from "../../accounts/mailServer";
import type { ProviderModule } from "../../accounts/types";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import type { ImapBridge } from "./bridge";
import { ImapProvider } from "./ImapProvider";
import { ImapSession } from "./ImapSession";

/** Options of {@link createImapModule}. */
export interface ImapModuleOptions {
  readonly bridge: ImapBridge;
  /** Accounts kept at earlier starts: their settings and names. */
  readonly accounts: ReadonlyMap<string, MailServerAccountInfo>;
  /** Where signatures are kept (localStorage). */
  readonly settings: Storage | undefined;
  /** For one-click unsubscribe (the native fetch). */
  readonly fetch?: typeof fetch;
}

/** localStorage key of an account's signatures (IMAP servers keep none). */
export function signaturesKey(accountId: string): string {
  return `a0.settings.signatures.${accountId}`;
}

/** SMTP servers that put a copy of sent mail into Sent themselves. */
const SAVES_SENT = /(^|\.)(gmail|googlemail)\.com$/i;

/**
 * IMAP/SMTP accounts (the apps only). Accounts are added with the setup
 * the Add account wizard collected (`connect(setup)`); the native side
 * keeps the password and settings.
 */
export function createImapModule(options: ImapModuleOptions): ProviderModule {
  const infos = new Map(options.accounts);
  const service = (account: Account) =>
    infos.get(account.id)?.settings.imap.host ??
    account.email.split("@").at(-1) ??
    "IMAP";
  const session = (account: Account) => {
    const info = infos.get(account.id);
    const auth = new ImapSession({
      bridge: options.bridge,
      key: account.id,
      reauth: info?.signIn === "password" || !info ? "password" : "browser",
      service: service(account),
    });
    // Not kept by the native side (no keychain at the last start): sign in again.
    if (!info) auth.markExpired();
    return auth;
  };
  return {
    type: "imap",
    label: "IMAP",
    connect: async (input) => {
      const setup = input as MailServerSetup | undefined;
      if (!setup)
        throw new Error("Mail server accounts are added with their settings.");
      const info = await options.bridge.connect(setup);
      infos.set(info.key, info);
      const account: Account = {
        id: asAccountId(info.key),
        type: "imap",
        email: info.address,
      };
      return { account, auth: session(account) };
    },
    restore: session,
    createProvider: (account, auth) => {
      const info = infos.get(account.id);
      return new ImapProvider({
        bridge: options.bridge,
        key: account.id,
        address: account.email,
        ...(info?.name ? { name: info.name } : {}),
        service: service(account),
        ...(info?.maxBytes === undefined ? {} : { maxBytes: info.maxBytes }),
        savesSent: SAVES_SENT.test(info?.settings.smtp.host ?? ""),
        settings: options.settings,
        signatureKey: signaturesKey(account.id),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        onAuthFailed: () => {
          auth.markExpired();
        },
      });
    },
  };
}
