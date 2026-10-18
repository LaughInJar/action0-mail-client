import type { ProviderModule } from "../../accounts/types";
import { GoogleAuthSession } from "../../auth/google/GoogleAuthSession";
import { loadGis, peekGis } from "../../auth/google/gis";
import { requestGoogleToken } from "../../auth/google/tokenRequest";
import { sessionTokenStore } from "../../auth/google/tokenStore";
import { StaticAuthSession } from "../../auth/staticSession";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import { GmailHttp } from "./http";
import { GmailProvider } from "./GmailProvider";
import type { GmailProfile } from "./types";

/**
 * Read and modify mail (labels, read state), but not delete it permanently.
 * Tokens without it, e.g. read-only tokens from before, count as expired.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Configuration of the Gmail provider module. */
export interface GmailModuleOptions {
  /** OAuth client ID of type "Web application". */
  readonly clientId: string;
  /** Where tokens live between reloads (sessionStorage). */
  readonly tokenStorage: Storage | undefined;
}

/** Wires Google sign-in and the Gmail provider into the account registry. */
export function createGmailModule({
  clientId,
  tokenStorage,
}: GmailModuleOptions): ProviderModule {
  // Load GIS early so sign-in can open its popup inside the click handler.
  loadGis().catch(() => {
    // Reported again (with UI) when the user tries to sign in.
  });

  const sessionFor = (account: Account) =>
    new GoogleAuthSession({
      clientId,
      scope: GMAIL_SCOPE,
      loginHint: account.email,
      tokenStore: sessionTokenStore(account.id, tokenStorage),
    });

  return {
    type: "gmail",
    label: "Google / Gmail",

    async connect() {
      const ready = peekGis();
      const token = await requestGoogleToken(ready ?? (await loadGis()), {
        clientId,
        scope: GMAIL_SCOPE,
        prompt: "select_account",
      });

      // The token response doesn't say whose token it is; ask Gmail.
      const probe = new StaticAuthSession("signed-in", token.accessToken);
      const profile = await new GmailHttp({ auth: probe }).get<GmailProfile>(
        "profile",
      );

      const account: Account = {
        id: asAccountId(`gmail:${profile.emailAddress.toLowerCase()}`),
        type: "gmail",
        email: profile.emailAddress,
      };
      sessionTokenStore(account.id, tokenStorage).save(token);
      return { account, auth: sessionFor(account) };
    },

    restore: sessionFor,

    createProvider: (_account, auth) =>
      new GmailProvider(new GmailHttp({ auth })),
  };
}
