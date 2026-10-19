/// <reference types="vite/client" />

/** Version from package.json, injected by Vite. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** OAuth client ID ("Web application") for Google sign-in. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Application (client) ID of the Microsoft Entra app registration. */
  readonly VITE_MICROSOFT_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
