/** Build-time configuration. */
export interface AppConfig {
  /** OAuth client ID for Google sign-in; Gmail is unavailable without it. */
  readonly googleClientId: string | undefined;
  /** Client ID of the Microsoft Entra app; Microsoft accounts are unavailable without it. */
  readonly microsoftClientId: string | undefined;
  /** The desktop app's Google client ("Desktop app" type, with its secret). */
  readonly googleDesktopClient: GoogleDesktopClient | undefined;
  /** Yahoo's and AOL's app registrations for mail (approved by Yahoo), if any. */
  readonly yahooClient: OAuthClient | undefined;
  readonly aolClient: OAuthClient | undefined;
  readonly version: string;
}

/** A Google OAuth client of type "Desktop app". */
export interface GoogleDesktopClient {
  readonly id: string;
  /** Not confidential: Google's desktop clients ship it with the app. */
  readonly secret: string;
}

/** An OAuth app registration; the secret only if the provider gave one. */
export interface OAuthClient {
  readonly id: string;
  readonly secret?: string;
}

/** A client from its environment values. */
function client(
  id: string | undefined,
  secret: string | undefined,
): OAuthClient | undefined {
  if (id === undefined) return undefined;
  return secret === undefined ? { id } : { id, secret };
}

/** A trimmed environment value, undefined when empty. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Reads the configuration from Vite's environment variables. */
export function readConfig(): AppConfig {
  const desktopId = value(import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_ID);
  const desktopSecret = value(
    import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_SECRET,
  );
  return {
    googleClientId: value(import.meta.env.VITE_GOOGLE_CLIENT_ID),
    microsoftClientId: value(import.meta.env.VITE_MICROSOFT_CLIENT_ID),
    googleDesktopClient:
      desktopId !== undefined && desktopSecret !== undefined
        ? { id: desktopId, secret: desktopSecret }
        : undefined,
    yahooClient: client(
      value(import.meta.env.VITE_YAHOO_CLIENT_ID),
      value(import.meta.env.VITE_YAHOO_CLIENT_SECRET),
    ),
    aolClient: client(
      value(import.meta.env.VITE_AOL_CLIENT_ID),
      value(import.meta.env.VITE_AOL_CLIENT_SECRET),
    ),
    version: __APP_VERSION__,
  };
}
