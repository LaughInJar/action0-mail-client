/** Build-time configuration. */
export interface AppConfig {
  /** OAuth client ID for Google sign-in; Gmail is unavailable without it. */
  readonly googleClientId: string | undefined;
  /** Client ID of the Microsoft Entra app; Microsoft accounts are unavailable without it. */
  readonly microsoftClientId: string | undefined;
  readonly version: string;
}

/** A trimmed environment value, undefined when empty. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Reads the configuration from Vite's environment variables. */
export function readConfig(): AppConfig {
  return {
    googleClientId: value(import.meta.env.VITE_GOOGLE_CLIENT_ID),
    microsoftClientId: value(import.meta.env.VITE_MICROSOFT_CLIENT_ID),
    version: __APP_VERSION__,
  };
}
