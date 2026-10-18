/** Build-time configuration. */
export interface AppConfig {
  /** OAuth client ID for Google sign-in; Gmail is unavailable without it. */
  readonly googleClientId: string | undefined;
  readonly version: string;
}

/** Reads the configuration from Vite's environment variables. */
export function readConfig(): AppConfig {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
  return {
    googleClientId:
      clientId === undefined || clientId === "" ? undefined : clientId,
    version: __APP_VERSION__,
  };
}
