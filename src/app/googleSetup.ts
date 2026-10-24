import type { AccountRegistry } from "../accounts/AccountRegistry";
import type {
  ProviderSetup,
  SettingSource,
  SetupProblem,
} from "../accounts/types";
import type { NativeSignIn } from "../auth/native/bridge";
import { readJson, writeJson } from "../lib/storage";
import { createGmailModule } from "../providers/gmail/module";
import type { GoogleDesktopClient } from "./config";

/** localStorage key of the Google OAuth client ID entered in the wizard (a setting, not a secret). */
export const GOOGLE_CLIENT_ID_KEY = "a0.settings.googleClientId";

const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

/** Why a value isn't a Google OAuth client ID, or undefined if it looks like one. */
export function validateGoogleClientId(
  value: string,
): SetupProblem | undefined {
  const id = value.trim();
  if (id === "") return "missing";
  // Client secrets start like this.
  if (id.startsWith("GOCSPX-")) return "secret";
  if (/^https?:\/\//i.test(id)) return "url";
  if (!CLIENT_ID.test(id)) return "malformed";
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

/** localStorage key of the desktop app's Google client (ID and secret; neither is confidential for desktop clients). */
export const GOOGLE_DESKTOP_CLIENT_KEY = "a0.settings.googleDesktopClient";

/** Why a value isn't a Google desktop client secret, or undefined if it looks like one. */
export function validateGoogleClientSecret(
  value: string,
): SetupProblem | undefined {
  const secret = value.trim();
  if (secret === "") return "missing";
  if (/^https?:\/\//i.test(secret)) return "url";
  if (CLIENT_ID.test(secret)) return "malformed";
  if (!/^[\w-]{10,}$/.test(secret)) return "malformed";
  return undefined;
}

/** The desktop client stored in the app, if it's valid. */
export function storedGoogleDesktopClient(
  storage: Storage | undefined,
): GoogleDesktopClient | undefined {
  const value = readJson(storage, GOOGLE_DESKTOP_CLIENT_KEY);
  if (typeof value !== "object" || value === null) return undefined;
  const { id, secret } = value as { id?: unknown; secret?: unknown };
  return typeof id === "string" &&
    typeof secret === "string" &&
    validateGoogleClientId(id) === undefined &&
    validateGoogleClientSecret(secret) === undefined
    ? { id, secret }
    : undefined;
}

/** Options of {@link createGoogleDesktopSetup}. */
export interface GoogleDesktopSetupOptions {
  readonly registry: AccountRegistry;
  /** From `VITE_GOOGLE_DESKTOP_CLIENT_*`, which take precedence. */
  readonly buildClient: GoogleDesktopClient | undefined;
  /** Where the app's settings live (localStorage). */
  readonly settings: Storage | undefined;
  /** Native sign-in, without the client (that's what's set up here). */
  readonly native: Omit<NativeSignIn, "client">;
  readonly fetch: typeof fetch;
}

/** Lets the user enter the desktop app's Google client (ID and secret). */
export function createGoogleDesktopSetup({
  registry,
  buildClient,
  settings,
  native,
  fetch,
}: GoogleDesktopSetupOptions): ProviderSetup {
  return {
    type: "gmail",
    current: () => {
      if (buildClient !== undefined)
        return {
          value: buildClient.id,
          secret: buildClient.secret,
          source: "build" satisfies SettingSource,
        };
      const stored = storedGoogleDesktopClient(settings);
      return stored === undefined
        ? undefined
        : { value: stored.id, secret: stored.secret, source: "browser" };
    },
    validate: validateGoogleClientId,
    secret: { validate: validateGoogleClientSecret },
    apply: (value, secret = "") => {
      const client = { id: value.trim(), secret: secret.trim() };
      if (
        validateGoogleClientId(client.id) !== undefined ||
        validateGoogleClientSecret(client.secret) !== undefined
      )
        return;
      if (buildClient === undefined)
        writeJson(settings, GOOGLE_DESKTOP_CLIENT_KEY, client);
      registry.registerModule(
        createGmailModule({
          clientId: client.id,
          tokenStorage: undefined,
          native: { ...native, client },
          fetch,
        }),
      );
    },
  };
}
