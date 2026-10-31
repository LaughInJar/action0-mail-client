import type { ProviderModule } from "../../accounts/types";
import type { NativeSignIn } from "../../auth/native/bridge";
import {
  connectNative,
  NativeAuthSession,
} from "../../auth/native/NativeAuthSession";
import type { AuthSession, ScopedSession } from "../../auth/types";
import {
  MicrosoftAuthSession,
  sessionAccountStore,
} from "../../auth/microsoft/MicrosoftAuthSession";
import {
  CALENDAR_SCOPES,
  GRAPH_SCOPES,
  msalLoader,
  PERSONAL_TENANT_ID,
  signInError,
} from "../../auth/microsoft/msal";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import { SenderStore } from "../senderStore";
import { GraphHttp } from "./http";
import { GraphCalendarProvider } from "./calendar";
import { GraphFilterProvider } from "./filters";
import { GraphProvider } from "./GraphProvider";

/** Configuration of the Microsoft provider module. */
export interface MicrosoftModuleOptions {
  /** Application (client) ID of the Entra app registration (SPA). */
  readonly clientId: string;
  /** Where MSAL's account hints live between reloads (sessionStorage). */
  readonly sessionStorage: Storage | undefined;
  /** Where settings live (localStorage): From addresses and signatures of Microsoft accounts. */
  readonly settings: Storage | undefined;
  /** Desktop app: sign in natively (system browser) instead of with MSAL. */
  readonly native?: NativeSignIn;
  /** Makes the network requests (the desktop app's own); `fetch` if absent. */
  readonly fetch?: typeof fetch;
}

/** Everything the desktop app asks for at once. */
const NATIVE_SCOPES = [
  ...GRAPH_SCOPES,
  ...CALENDAR_SCOPES,
  "openid",
  "profile",
];

/** What the calendar needs of a session: calendar tokens and consent. */
type CalendarSession = AuthSession &
  ScopedSession & {
    readonly loginHint: string;
    tokenFor(scopes: readonly string[]): Promise<string>;
  };

/** Wires Microsoft sign-in (MSAL) and the Graph provider into the account registry. */
export function createMicrosoftModule({
  clientId,
  sessionStorage,
  settings,
  native,
  fetch,
}: MicrosoftModuleOptions): ProviderModule {
  const net = fetch ? { fetch } : {};
  /** Personal accounts, by account id (their attachment limit is lower). */
  const personal = new Set<string>();
  const isPersonal = (account: Account) =>
    personal.has(account.id) ||
    /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(account.email);
  const parts = {
    createCalendar: (_account: Account, auth: AuthSession) => {
      const session = auth as CalendarSession;
      return new GraphCalendarProvider(
        new GraphHttp({
          auth,
          token: () => session.tokenFor(CALENDAR_SCOPES),
          ...net,
        }),
        session,
      );
    },
    createProvider: (account: Account, auth: AuthSession) =>
      new GraphProvider(new GraphHttp({ auth, ...net }), {
        personal: isPersonal(account),
        senders: new SenderStore(settings, account.id),
        ...net,
      }),
    createFilters: (account: Account, auth: AuthSession) =>
      new GraphFilterProvider(new GraphHttp({ auth, ...net }), {
        personal: isPersonal(account),
      }),
  };
  if (native)
    return {
      type: "microsoft",
      label: "Microsoft / Outlook",
      ...nativeSignIn(native, clientId, personal),
      ...parts,
    };

  const msal = msalLoader(clientId);

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
          // New accounts consent to calendar access right away.
          extraScopesToConsent: [...CALENDAR_SCOPES],
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
    ...parts,
  };
}

/** Signing in through the system browser (desktop app). */
function nativeSignIn(
  native: NativeSignIn,
  clientId: string,
  personal: Set<string>,
): Pick<ProviderModule, "connect" | "restore"> {
  const request = {
    provider: "microsoft",
    client: { id: clientId },
    scopes: NATIVE_SCOPES,
    required: ["Mail.ReadWrite", "Mail.Send"],
  } as const;
  const sessionFor = (
    account: Account,
    granted = native.accounts.get(account.id)?.scopes ?? [],
  ) =>
    new NativeAuthSession({
      ...request,
      bridge: native.bridge,
      key: account.id,
      loginHint: account.email,
      granted,
      providerName: "Microsoft",
    });
  for (const known of native.accounts.values())
    if (known.tenant === PERSONAL_TENANT_ID) personal.add(known.key);
  return {
    async connect() {
      const signedIn = await connectNative(
        native.bridge,
        { ...request, prompt: "select_account" },
        "Microsoft",
      );
      const account: Account = {
        id: asAccountId(signedIn.key),
        type: "microsoft",
        email: signedIn.email,
      };
      if (signedIn.tenant === PERSONAL_TENANT_ID) personal.add(account.id);
      return { account, auth: sessionFor(account, signedIn.scopes) };
    },
    restore: (account) => sessionFor(account),
  };
}
