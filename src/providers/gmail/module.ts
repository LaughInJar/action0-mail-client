import type { ProviderModule } from "../../accounts/types";
import { GoogleAuthSession } from "../../auth/google/GoogleAuthSession";
import { loadGis, peekGis } from "../../auth/google/gis";
import { requestGoogleToken } from "../../auth/google/tokenRequest";
import { sessionTokenStore } from "../../auth/google/tokenStore";
import { StaticAuthSession } from "../../auth/staticSession";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import {
  CALENDAR_API_BASE,
  CALENDAR_SCOPES,
  GoogleCalendarProvider,
} from "./calendar";
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
 * Changing Gmail settings, for editing signatures. Optional: declined, the
 * signatures are read-only.
 */
export const SETTINGS_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";

/** Permissions that are asked for but may be declined. */
const OPTIONAL_SCOPES = `${CONTACTS_SCOPES} ${SETTINGS_SCOPE}`;

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
      optionalScope: OPTIONAL_SCOPES,
      onDemandScopes: CALENDAR_SCOPES,
      loginHint: account.email,
      tokenStore: sessionTokenStore(account.id, tokenStorage),
    });

  return {
    type: "gmail",
    label: "Google / Gmail",

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

    createCalendar: (_account, auth) =>
      new GoogleCalendarProvider(
        new GmailHttp({
          auth,
          baseUrl: CALENDAR_API_BASE,
          service: "Google Calendar",
        }),
        auth as GoogleAuthSession,
      ),

    createProvider: (_account, auth) =>
      new GmailProvider(new GmailHttp({ auth }), {
        people: new GmailHttp({
          auth,
          baseUrl: PEOPLE_API_BASE,
          service: "Google Contacts",
        }),
      }),
  };
}
