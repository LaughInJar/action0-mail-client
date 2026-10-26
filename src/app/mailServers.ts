/**
 * Mail server (IMAP/SMTP) accounts for the Add account wizard: looking up
 * settings and adding accounts through the native bridge, and the Yahoo/AOL
 * app registrations (from the build, else entered in the app).
 */
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type {
  MailServerAccounts,
  MailServerOAuth,
  MailServerOAuthClient,
} from "../accounts/mailServer";
import { readJson, writeJson } from "../lib/storage";
import type { ImapBridge } from "../providers/imap/bridge";
import type { AppConfig } from "./config";

/** localStorage key of a Yahoo/AOL app registration entered in the app. */
const clientKey = (provider: MailServerOAuth) =>
  `a0.settings.oauthClient.${provider}`;

/** A stored registration, if it's well-formed. */
function storedClient(
  storage: Storage | undefined,
  provider: MailServerOAuth,
): MailServerOAuthClient | undefined {
  const value = readJson(storage, clientKey(provider));
  if (typeof value !== "object" || value === null) return undefined;
  const { id, secret } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.trim() === "") return undefined;
  return typeof secret === "string" && secret !== "" ? { id, secret } : { id };
}

/** See the module docs. */
export function createMailServerAccounts(options: {
  readonly registry: AccountRegistry;
  readonly bridge: ImapBridge;
  readonly config: AppConfig;
  readonly settings: Storage | undefined;
}): MailServerAccounts {
  const { registry, bridge, config, settings } = options;
  const built = (provider: MailServerOAuth) =>
    provider === "yahoo" ? config.yahooClient : config.aolClient;
  return {
    discover: bridge.discover,
    add: (setup) => registry.add("imap", setup),
    info: async (accountId) =>
      (await bridge.accounts()).accounts.find(
        (account) => account.key === accountId,
      ),
    forgetCertificate: bridge.forgetCertificate,
    oauthClient: (provider) => {
      const fromBuild = built(provider);
      if (fromBuild) return { client: fromBuild, source: "build" };
      const entered = storedClient(settings, provider);
      return entered ? { client: entered, source: "app" } : undefined;
    },
    setOAuthClient: (provider, client) => {
      writeJson(settings, clientKey(provider), {
        id: client.id.trim(),
        ...(client.secret?.trim() ? { secret: client.secret.trim() } : {}),
      });
    },
  };
}
