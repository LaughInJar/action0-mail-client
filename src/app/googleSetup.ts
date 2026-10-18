import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderSetup, SettingSource } from "../accounts/types";
import { readJson, writeJson } from "../lib/storage";
import { createGmailModule } from "../providers/gmail/module";

/** localStorage key of the Google OAuth client ID entered in the wizard (a setting, not a secret). */
export const GOOGLE_CLIENT_ID_KEY = "a0.settings.googleClientId";

const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

/** Why a value isn't a Google OAuth client ID, or undefined if it looks like one. */
export function validateGoogleClientId(value: string): string | undefined {
  const id = value.trim();
  if (id === "") return "Paste the client ID from Google Cloud.";
  if (id.startsWith("GOCSPX-")) {
    return "That's the client secret. The app needs the client ID, which ends with .apps.googleusercontent.com.";
  }
  if (/^https?:\/\//i.test(id)) {
    return "That's a web address. The client ID ends with .apps.googleusercontent.com.";
  }
  if (!CLIENT_ID.test(id)) {
    return "This doesn't look like a Google client ID. It ends with .apps.googleusercontent.com.";
  }
  return undefined;
}

/** The client ID stored in this browser, if it's valid. */
export function storedGoogleClientId(
  storage: Storage | undefined,
): string | undefined {
  const value = readJson(storage, GOOGLE_CLIENT_ID_KEY);
  return typeof value === "string" &&
    validateGoogleClientId(value) === undefined
    ? value
    : undefined;
}

/** Options of {@link createGoogleSetup}. */
export interface GoogleSetupOptions {
  readonly registry: AccountRegistry;
  /** `VITE_GOOGLE_CLIENT_ID`, which takes precedence over the browser setting. */
  readonly buildClientId: string | undefined;
  /** Where the browser setting lives (localStorage). */
  readonly settings: Storage | undefined;
  /** Where Gmail tokens live (sessionStorage). */
  readonly tokenStorage: Storage | undefined;
}

/** Lets the user enter Google's client ID in the wizard instead of `.env.local`. */
export function createGoogleSetup({
  registry,
  buildClientId,
  settings,
  tokenStorage,
}: GoogleSetupOptions): ProviderSetup {
  return {
    type: "gmail",
    current: () => {
      if (buildClientId !== undefined) {
        return {
          value: buildClientId,
          source: "build" satisfies SettingSource,
        };
      }
      const stored = storedGoogleClientId(settings);
      return stored === undefined
        ? undefined
        : { value: stored, source: "browser" };
    },
    validate: validateGoogleClientId,
    apply: (value) => {
      const clientId = value.trim();
      if (validateGoogleClientId(clientId) !== undefined) return;
      if (buildClientId === undefined)
        writeJson(settings, GOOGLE_CLIENT_ID_KEY, clientId);
      registry.registerModule(createGmailModule({ clientId, tokenStorage }));
    },
  };
}
