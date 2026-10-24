/** Build-time configuration. */
export interface AppConfig {
  /** OAuth client ID for Google sign-in; Gmail is unavailable without it. */
  readonly googleClientId: string | undefined;
  /** Client ID of the Microsoft Entra app; Microsoft accounts are unavailable without it. */
  readonly microsoftClientId: string | undefined;
  /** The desktop app's Google client ("Desktop app" type, with its secret). */
  readonly googleDesktopClient: GoogleDesktopClient | undefined;
  readonly version: string;
}

/** A Google OAuth client of type "Desktop app". */
export interface GoogleDesktopClient {
  readonly id: string;
  /** Not confidential: Google's desktop clients ship it with the app. */
  readonly secret: string;
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
    version: __APP_VERSION__,
  };
}
