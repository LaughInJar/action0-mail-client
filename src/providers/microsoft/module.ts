import type { ProviderModule } from "../../accounts/types";
import {
  MicrosoftAuthSession,
  sessionAccountStore,
} from "../../auth/microsoft/MicrosoftAuthSession";
import {
  GRAPH_SCOPES,
  msalLoader,
  PERSONAL_TENANT_ID,
  signInError,
} from "../../auth/microsoft/msal";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import { GraphHttp } from "./http";
import { GraphProvider } from "./GraphProvider";

/** Configuration of the Microsoft provider module. */
export interface MicrosoftModuleOptions {
  /** Application (client) ID of the Entra app registration (SPA). */
  readonly clientId: string;
  /** Where MSAL's account hints live between reloads (sessionStorage). */
  readonly sessionStorage: Storage | undefined;
  /** Where settings live (localStorage): the signatures of Microsoft accounts. */
  readonly settings: Storage | undefined;
}

/** localStorage key of an account's signatures (Graph can't store them). */
export function signatureKey(accountId: string): string {
  return `a0.settings.signatures.${accountId}`;
}

/** Wires Microsoft sign-in (MSAL) and the Graph provider into the account registry. */
export function createMicrosoftModule({
  clientId,
  sessionStorage,
  settings,
}: MicrosoftModuleOptions): ProviderModule {
  const msal = msalLoader(clientId);
  /** Personal accounts, by account id (their attachment limit is lower). */
  const personal = new Set<string>();

  const sessionFor = (account: Account) =>
    new MicrosoftAuthSession({
      loginHint: account.email,
      msal,
      accountStore: sessionAccountStore(account.id, sessionStorage),
    });

  return {
    type: "microsoft",
    label: "Microsoft / Outlook",

    prepare: async () => {
      await msal.load();
    },

    async connect() {
      // Open the popup synchronously when MSAL is ready, inside the click.
      const client = msal.peek() ?? (await msal.load());
      let result;
      try {
        result = await client.acquireTokenPopup({
          scopes: [...GRAPH_SCOPES],
          prompt: "select_account",
        });
      } catch (error) {
        throw signInError(error);
      }

      // The sign-in name: what MSAL finds the account by, and the login hint.
      const email = result.account.username;
      const account: Account = {
        id: asAccountId(`microsoft:${email.toLowerCase()}`),
        type: "microsoft",
        email,
      };
      sessionAccountStore(account.id, sessionStorage).save(
        result.account.homeAccountId,
      );
      if (result.account.tenantId === PERSONAL_TENANT_ID)
        personal.add(account.id);
      return { account, auth: sessionFor(account) };
    },

    restore: sessionFor,

    createProvider: (account, auth) =>
      new GraphProvider(new GraphHttp({ auth }), {
        personal:
          personal.has(account.id) ||
          /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(account.email),
        settings,
        signatureKey: signatureKey(account.id),
      }),
  };
}
