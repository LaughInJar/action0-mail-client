import { MailError } from "../../core/errors";
import type { GoogleOAuth2 } from "./gis";
import type { StoredToken } from "./tokenStore";

/** Parameters of one GIS token request. */
export interface GoogleTokenRequest {
  readonly clientId: string;
  /** Space-separated scopes to ask for. */
  readonly scope: string;
  /**
   * The ones that must be granted (space-separated); defaults to all of
   * {@link scope}. Google lets users untick the others.
   */
  readonly required?: string;
  /**
   * `""` shows UI only when needed (the popup closes by itself if the user is
   * signed in to Google and has consented before). `"select_account"` always
   * shows the account chooser.
   */
  readonly prompt: "" | "select_account" | "consent";
  /** Email of the expected account. */
  readonly loginHint?: string;
}

/**
 * Requests an access token through the GIS token model.
 *
 * Opens a popup, so it must run inside a user gesture. When `oauth2` is
 * already loaded, the popup is opened synchronously.
 */
export function requestGoogleToken(
  oauth2: GoogleOAuth2,
  request: GoogleTokenRequest,
  now: () => number = Date.now,
): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: request.clientId,
      scope: request.scope,
      callback: (response) => {
        if (response.error) {
          reject(
            new MailError(
              "auth-required",
              `Google sign-in failed: ${response.error_description || response.error}`,
              {
                reason: "signInFailed",
                params: {
                  detail: response.error_description || response.error,
                },
              },
            ),
          );
        } else if (
          !grantedAll(oauth2, response, request.required ?? request.scope)
        ) {
          reject(
            new MailError(
              "auth-required",
              "The requested access was not granted. Please allow it in the Google dialog.",
              { reason: "accessNotGranted" },
            ),
          );
        } else {
          resolve({
            accessToken: response.access_token,
            expiresAt: now() + Number(response.expires_in) * 1000,
            scope: response.scope,
            requested: request.scope,
          });
        }
      },
      error_callback: (error) => {
        reject(clientError(error));
      },
    });
    client.requestAccessToken({
      prompt: request.prompt,
      ...(request.loginHint ? { login_hint: request.loginHint } : {}),
    });
  });
}

function grantedAll(
  oauth2: GoogleOAuth2,
  response: google.accounts.oauth2.TokenResponse,
  scopes: string,
): boolean {
  const [first = "", ...rest] = scopes.split(" ").filter(Boolean);
  return oauth2.hasGrantedAllScopes(response, first, ...rest);
}

function clientError(
  error: google.accounts.oauth2.ClientConfigError,
): MailError {
  switch (error.type) {
    case "popup_closed":
      return new MailError(
        "auth-required",
        "The Google sign-in window was closed.",
        { reason: "signInClosed" },
      );
    case "popup_failed_to_open":
      return new MailError(
        "auth-required",
        "The Google sign-in window was blocked. Please allow popups for this site.",
        { reason: "signInBlocked" },
      );
    case "unknown":
      return new MailError(
        "auth-required",
        `Google sign-in failed: ${error.message}`,
        { reason: "signInFailed", params: { detail: error.message } },
      );
  }
}
