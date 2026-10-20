import type {
  AccountInfo,
  AuthenticationResult,
  ClearCacheRequest,
  PopupRequest,
  SilentRequest,
  SsoSilentRequest,
} from "@azure/msal-browser";
import { MailError } from "../../core/errors";

/**
 * Microsoft Graph permissions action0 asks for (delegated). MSAL adds
 * `openid` and `profile` by itself.
 */
export const GRAPH_SCOPES: readonly string[] = [
  "Mail.ReadWrite",
  "Mail.Send",
  "People.Read",
  "User.Read",
  "offline_access",
];

/** Calendar access: asked for when connecting, or later with "Allow calendar". */
export const CALENDAR_SCOPES: readonly string[] = ["Calendars.ReadWrite"];

/** Signs in work/school and personal Microsoft accounts. */
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common";

/** The tenant of every personal Microsoft account (Outlook.com, Hotmail). */
export const PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** The part of MSAL's `PublicClientApplication` that action0 uses. */
export interface MsalClient {
  readonly acquireTokenSilent: (
    request: SilentRequest,
  ) => Promise<AuthenticationResult>;
  readonly ssoSilent: (
    request: SsoSilentRequest,
  ) => Promise<AuthenticationResult>;
  readonly acquireTokenPopup: (
    request: PopupRequest,
  ) => Promise<AuthenticationResult>;
  readonly getAllAccounts: () => AccountInfo[];
  readonly clearCache: (request?: ClearCacheRequest) => Promise<void>;
}

/** Loads MSAL for a client ID, or returns it without waiting once loaded. */
export interface MsalLoader {
  readonly peek: () => MsalClient | undefined;
  readonly load: () => Promise<MsalClient>;
}

/** The page MSAL's popup and silent iframe return to (`redirect.html`). */
export function redirectUri(): string {
  return new URL(
    `${import.meta.env.BASE_URL}redirect.html`,
    window.location.origin,
  ).href;
}

const ready = new Map<string, MsalClient>();
const loading = new Map<string, Promise<MsalClient>>();

/**
 * MSAL for one client ID, loaded on first use (Gmail-only users never
 * download it). Tokens are cached in sessionStorage, never localStorage.
 * Load it before the click that signs in, so the popup can open inside the
 * user gesture.
 */
export function msalLoader(clientId: string): MsalLoader {
  const load = (): Promise<MsalClient> => {
    const done = ready.get(clientId);
    if (done) return Promise.resolve(done);
    let pending = loading.get(clientId);
    if (!pending) {
      pending = import("@azure/msal-browser")
        .then(({ createStandardPublicClientApplication }) =>
          createStandardPublicClientApplication({
            auth: {
              clientId,
              authority: MICROSOFT_AUTHORITY,
              redirectUri: redirectUri(),
            },
            cache: { cacheLocation: "sessionStorage" },
          }),
        )
        .then((client) => {
          ready.set(clientId, client);
          return client;
        })
        .catch((cause: unknown) => {
          loading.delete(clientId);
          throw new MailError("network", "Could not load Microsoft sign-in.", {
            cause,
            reason: "signInUnavailable",
            params: { provider: "Microsoft" },
          });
        });
      loading.set(clientId, pending);
    }
    return pending;
  };
  return { peek: () => ready.get(clientId), load };
}

/** What MSAL's errors carry (checked by shape, so MSAL stays lazily loaded). */
interface MsalErrorShape {
  readonly name?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly subError?: string;
}

function shapeOf(error: unknown): MsalErrorShape {
  return typeof error === "object" && error !== null ? error : {};
}

/** MSAL can't get a token without showing the user something. */
export function needsInteraction(error: unknown): boolean {
  const { name, errorCode = "" } = shapeOf(error);
  return (
    name === "InteractionRequiredAuthError" ||
    [
      "interaction_required",
      "login_required",
      "consent_required",
      "no_account_error",
      "no_tokens_found",
      "monitor_window_timeout",
      "timed_out",
      "iframe_closed_prematurely",
      "redirect_bridge_timeout",
    ].includes(errorCode)
  );
}

/** A failed interactive sign-in as a {@link MailError} the interface can describe. */
export function signInError(error: unknown): MailError {
  const { errorCode = "", errorMessage = "" } = shapeOf(error);
  const provider = { provider: "Microsoft" };
  if (errorCode === "user_cancelled")
    return new MailError(
      "auth-required",
      "The Microsoft sign-in window was closed.",
      { cause: error, reason: "signInClosed", params: provider },
    );
  if (errorCode === "popup_window_error" || errorCode === "empty_window_error")
    return new MailError(
      "auth-required",
      "The Microsoft sign-in window was blocked.",
      { cause: error, reason: "signInBlocked", params: provider },
    );
  // AADSTS65001 / 90094: the organisation requires an admin's consent.
  if (/AADSTS(65001|90094|90095)/.test(errorMessage))
    return new MailError(
      "auth-required",
      "An administrator has to approve action0 first.",
      { cause: error, reason: "adminApprovalNeeded" },
    );
  if (errorCode === "access_denied" || errorMessage.includes("AADSTS65004"))
    return new MailError(
      "auth-required",
      "The requested access was not granted.",
      { cause: error, reason: "accessNotGranted", params: provider },
    );
  const detail = errorMessage.split("\n")[0] || errorCode || String(error);
  return new MailError("auth-required", `Microsoft sign-in failed: ${detail}`, {
    cause: error,
    reason: "signInFailed",
    params: { ...provider, detail },
  });
}
