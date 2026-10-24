import type { AccountRegistry } from "../accounts/AccountRegistry";
import type {
  ProviderSetup,
  SettingSource,
  SetupProblem,
} from "../accounts/types";
import type { NativeSignIn } from "../auth/native/bridge";
import { readJson, writeJson } from "../lib/storage";
import { createMicrosoftModule } from "../providers/microsoft/module";

/** localStorage key of the Microsoft client ID entered in the wizard (a setting, not a secret). */
export const MICROSOFT_CLIENT_ID_KEY = "a0.settings.microsoftClientId";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a value isn't an Entra application (client) ID, or undefined if it looks like one. */
export function validateMicrosoftClientId(
  value: string,
): SetupProblem | undefined {
  const id = value.trim();
  if (id === "") return "missing";
  // Client secret values contain a "~" (e.g. "Abc8Q~…").
  if (id.includes("~")) return "secret";
  if (/^https?:\/\//i.test(id)) return "url";
  if (!GUID.test(id)) return "malformed";
  return undefined;
}

/** The client ID stored in this browser, if it's valid. */
export function storedMicrosoftClientId(
  storage: Storage | undefined,
): string | undefined {
  const value = readJson(storage, MICROSOFT_CLIENT_ID_KEY);
  return typeof value === "string" &&
    validateMicrosoftClientId(value) === undefined
    ? value
    : undefined;
}

/** Options of {@link createMicrosoftSetup}. */
export interface MicrosoftSetupOptions {
  readonly registry: AccountRegistry;
  /** `VITE_MICROSOFT_CLIENT_ID`, which takes precedence over the browser setting. */
  readonly buildClientId: string | undefined;
  /** Where the browser setting (and signatures) live: localStorage. */
  readonly settings: Storage | undefined;
  /** Where MSAL's account hints live: sessionStorage. */
  readonly sessionStorage: Storage | undefined;
  /** Desktop app: native sign-in (without the client: it's set up here) and networking. */
  readonly desktop?: {
    readonly native: Omit<NativeSignIn, "client">;
    readonly fetch: typeof fetch;
  };
}

/** Lets the user enter the Entra client ID in the wizard instead of `.env.local`. */
export function createMicrosoftSetup({
  registry,
  buildClientId,
  settings,
  desktop,
  sessionStorage,
}: MicrosoftSetupOptions): ProviderSetup {
  return {
    type: "microsoft",
    current: () => {
      if (buildClientId !== undefined) {
        return {
          value: buildClientId,
          source: "build" satisfies SettingSource,
        };
      }
      const stored = storedMicrosoftClientId(settings);
      return stored === undefined
        ? undefined
        : { value: stored, source: "browser" };
    },
    validate: validateMicrosoftClientId,
    apply: (value) => {
      const clientId = value.trim();
      if (validateMicrosoftClientId(clientId) !== undefined) return;
      if (buildClientId === undefined)
        writeJson(settings, MICROSOFT_CLIENT_ID_KEY, clientId);
      registry.registerModule(
        createMicrosoftModule({
          clientId,
          sessionStorage,
          settings,
          ...(desktop
            ? {
                native: { ...desktop.native, client: { id: clientId } },
                fetch: desktop.fetch,
              }
            : {}),
        }),
      );
    },
  };
}
