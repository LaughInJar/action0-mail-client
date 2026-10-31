import type { ProviderModule } from "../../accounts/types";
import type { AuthSession, ScopedSession } from "../../auth/types";
import { GoogleAuthSession } from "../../auth/google/GoogleAuthSession";
import { loadGis, peekGis } from "../../auth/google/gis";
import { requestGoogleToken } from "../../auth/google/tokenRequest";
import { sessionTokenStore } from "../../auth/google/tokenStore";
import type { NativeSignIn } from "../../auth/native/bridge";
import {
  connectNative,
  NativeAuthSession,
} from "../../auth/native/NativeAuthSession";
import { StaticAuthSession } from "../../auth/staticSession";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import {
  CALENDAR_API_BASE,
  CALENDAR_SCOPES,
  GoogleCalendarProvider,
} from "./calendar";
import { GmailFilterProvider, SETTINGS_SCOPE } from "./filters";
import { GmailHttp, PEOPLE_API_BASE } from "./http";
import { GmailProvider } from "./GmailProvider";
import type { GmailProfile } from "./types";

/**
 * Full access to the mailbox. Needed for permanent deletion ("Delete
 * forever", "Empty Trash"); everything else would work with `gmail.modify`.
 * Tokens with a narrower scope count as expired and ask for a reconnect.
 */
export const GMAIL_SCOPE = "https://mail.google.com/";

/**
 * Read-only access to contacts and "other contacts" (people you've written
 * to), for address suggestions. Optional: users may decline them.
 */
export const CONTACTS_SCOPES =
  "https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly";

/**
 * Changing Gmail settings (signatures, filters, the vacation responder).
 * Optional: declined, they are read-only.
 */
export { SETTINGS_SCOPE };

/** Permissions that are asked for but may be declined. */
const OPTIONAL_SCOPES = `${CONTACTS_SCOPES} ${SETTINGS_SCOPE}`;

/** Everything the desktop app asks for at once (it can't add scopes later). */
const NATIVE_SCOPES = [
  GMAIL_SCOPE,
  ...OPTIONAL_SCOPES.split(" "),
  ...CALENDAR_SCOPES,
  "openid",
  "email",
];

/** Configuration of the Gmail provider module. */
export interface GmailModuleOptions {
  /** OAuth client ID of type "Web application". */
  readonly clientId: string;
  /** Where tokens live between reloads (sessionStorage). */
  readonly tokenStorage: Storage | undefined;
  /** Desktop app: sign in natively (system browser) instead of with GIS. */
  readonly native?: NativeSignIn;
  /** Makes the network requests (the desktop app's own); `fetch` if absent. */
  readonly fetch?: typeof fetch;
}

/** Wires Google sign-in and the Gmail provider into the account registry. */
export function createGmailModule({
  clientId,
  tokenStorage,
  native,
  fetch,
}: GmailModuleOptions): ProviderModule {
  const net = fetch ? { fetch } : {};
  if (native) return gmailModule(nativeSignIn(native), net);

  // Load GIS early so sign-in can open its popup inside the click handler.
  loadGis().catch(() => {
    // Reported again (with UI) when the user tries to sign in.
  });

  const sessionFor = (account: Account) =>
    new GoogleAuthSession({
      clientId,
      scope: GMAIL_SCOPE,
      optionalScope: OPTIONAL_SCOPES,
      onDemandScopes: CALENDAR_SCOPES,
      loginHint: account.email,
      tokenStore: sessionTokenStore(account.id, tokenStorage),
    });

  return gmailModule(
    {
      prepare: async () => {
        await loadGis();
      },

      async connect() {
        const ready = peekGis();
        const token = await requestGoogleToken(ready ?? (await loadGis()), {
          clientId,
          // New accounts are asked for calendar access too (it can be unticked).
          scope: `${GMAIL_SCOPE} ${OPTIONAL_SCOPES} ${CALENDAR_SCOPES.join(" ")}`,
          required: GMAIL_SCOPE,
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
    },
    net,
  );
}

/** How the Gmail module signs accounts in. */
type GoogleSignIn = Pick<ProviderModule, "connect" | "restore"> &
  Partial<Pick<ProviderModule, "prepare">>;

/** Signing in through the system browser (desktop app). */
function nativeSignIn(native: NativeSignIn): GoogleSignIn {
  const request = {
    provider: "google",
    client: native.client,
    scopes: NATIVE_SCOPES,
    required: [GMAIL_SCOPE],
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
      providerName: "Google",
    });
  return {
    async connect() {
      const signedIn = await connectNative(
        native.bridge,
        { ...request, prompt: "select_account" },
        "Google",
      );
      const account: Account = {
        id: asAccountId(signedIn.key),
        type: "gmail",
        email: signedIn.email,
      };
      return { account, auth: sessionFor(account, signedIn.scopes) };
    },
    restore: (account) => sessionFor(account),
  };
}

/** The Gmail module around a way of signing in. */
function gmailModule(
  signIn: GoogleSignIn,
  net: { readonly fetch?: typeof fetch },
): ProviderModule {
  return {
    type: "gmail",
    label: "Google / Gmail",
    ...signIn,

    createCalendar: (_account, auth) =>
      new GoogleCalendarProvider(
        new GmailHttp({
          auth,
          baseUrl: CALENDAR_API_BASE,
          service: "Google Calendar",
          ...net,
        }),
        auth as AuthSession & ScopedSession,
      ),

    createFilters: (_account, auth) =>
      new GmailFilterProvider(
        new GmailHttp({ auth, ...net }),
        auth as AuthSession & ScopedSession,
      ),

    createProvider: (_account, auth) =>
      new GmailProvider(new GmailHttp({ auth, ...net }), {
        people: new GmailHttp({
          auth,
          baseUrl: PEOPLE_API_BASE,
          service: "Google Contacts",
          ...net,
        }),
        ...net,
      }),
  };
}
