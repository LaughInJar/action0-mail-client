/// <reference types="vite/client" />

/** Version from package.json, injected by Vite. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** OAuth client ID ("Web application") for Google sign-in. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Application (client) ID of the Microsoft Entra app registration. */
  readonly VITE_MICROSOFT_CLIENT_ID?: string;
  /** Desktop app: OAuth client ID of type "Desktop app" for Google sign-in. */
  readonly VITE_GOOGLE_DESKTOP_CLIENT_ID?: string;
  /** Desktop app: that client's secret (not confidential for desktop apps). */
  readonly VITE_GOOGLE_DESKTOP_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
