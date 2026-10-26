/**
 * The web app's {@link AiBackend}: keys in sessionStorage, or localStorage
 * for services the user asked to remember (the one opt-in exception to
 * keeping secrets out of localStorage), and requests from the page itself.
 * OpenRouter's sign-in runs in a popup that comes back to `redirect.html`.
 */
import type { AiBackend, AiHttpRequest } from "./backend";
import { AI_KINDS, serviceBaseUrl } from "./kinds";
import type { AiServiceConfig } from "./types";

/** Storage key of a service's key. */
const KEY_PREFIX = "a0.ai.key.";
/** Where `redirect.ts` hands OpenRouter's answer over. */
export const OPENROUTER_CHANNEL = "a0.ai.openrouter";
/** How long the OpenRouter popup may take. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** Inputs of {@link createWebAiBackend}. */
export interface WebAiBackendOptions {
  readonly session: Storage | undefined;
  readonly local: Storage | undefined;
  /** The page OpenRouter comes back to (`…/redirect.html`). */
  readonly redirectUrl: string;
  readonly fetch?: typeof fetch;
  readonly window?: Window;
}

/** See the module docs. */
export function createWebAiBackend(options: WebAiBackendOptions): AiBackend {
  const { session, local } = options;
  const fetcher = options.fetch ?? ((...args) => fetch(...args));
  const storageKey = (service: AiServiceConfig) => KEY_PREFIX + service.id;
  const readKey = (service: AiServiceConfig) =>
    session?.getItem(storageKey(service)) ??
    local?.getItem(storageKey(service)) ??
    undefined;
  const writeKey = (service: AiServiceConfig, key: string) => {
    const [keep, drop] = service.remember ? [local, session] : [session, local];
    try {
      keep?.setItem(storageKey(service), key);
    } catch {
      // A full or blocked storage: the key lasts until the page reloads.
    }
    drop?.removeItem(storageKey(service));
  };
  const keys = new Map<string, string>();

  const saveKey = (service: AiServiceConfig, key: string) => {
    keys.set(service.id, key);
    writeKey(service, key);
    return Promise.resolve();
  };

  return {
    keeps: "browser",
    credentials: () => {
      const ids = new Set(keys.keys());
      for (const storage of [session, local])
        for (let index = 0; index < (storage?.length ?? 0); index++) {
          const name = storage?.key(index);
          if (name?.startsWith(KEY_PREFIX))
            ids.add(name.slice(KEY_PREFIX.length));
        }
      return Promise.resolve({ ids, persistent: true });
    },
    send: (service, request, signal) => {
      const headers = new Headers(request.headers);
      const key = keys.get(service.id) ?? readKey(service);
      const header = AI_KINDS[service.kind].keyHeader;
      if (key && header === "x-api-key") headers.set("x-api-key", key);
      if (key && header === "bearer")
        headers.set("authorization", `Bearer ${key}`);
      if (key && !underBase(request, serviceBaseUrl(service)))
        return Promise.reject(
          new TypeError("The request isn't for this service."),
        );
      return fetcher(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal ? { signal } : {}),
        referrerPolicy: "no-referrer",
        credentials: "omit",
      });
    },
    saveKey,
    forget: (service) => {
      keys.delete(service.id);
      session?.removeItem(storageKey(service));
      local?.removeItem(storageKey(service));
      return Promise.resolve();
    },
    setRemember: (service, remember) => {
      const key = keys.get(service.id) ?? readKey(service);
      if (key !== undefined) writeKey({ ...service, remember }, key);
    },
    signIn: {
      openrouter: async (service) => {
        const key = await openRouterKey(options, fetcher);
        await saveKey(service, key);
      },
    },
  };
}

/** True if the request goes to the service's own address. */
function underBase(request: AiHttpRequest, base: string): boolean {
  return (
    request.url === base ||
    request.url.startsWith(`${base}/`) ||
    request.url.startsWith(`${base}?`)
  );
}

/**
 * OpenRouter's PKCE sign-in: a popup to its consent page, which comes back
 * to `redirect.html` with a code; the code and the verifier buy a key that
 * belongs to the user (billed to their OpenRouter credit).
 */
async function openRouterKey(
  options: WebAiBackendOptions,
  fetcher: typeof fetch,
): Promise<string> {
  const host = options.window ?? window;
  // Opened right away, inside the click, so popup blockers let it through.
  const popup = host.open(
    "about:blank",
    "a0-openrouter",
    "popup,width=520,height=720",
  );
  if (!popup) throw new Error("popup-blocked");
  try {
    const verifier = randomToken();
    const challenge = await sha256(verifier);
    const callback = `${options.redirectUrl}?to=openrouter`;
    popup.location.href = `https://openrouter.ai/auth?${new URLSearchParams({
      callback_url: callback,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()}`;
    const code = await waitForCode();
    const response = await fetcher("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      referrerPolicy: "no-referrer",
      credentials: "omit",
    });
    const body = (await response.json().catch(() => ({}))) as {
      key?: unknown;
    };
    if (!response.ok || typeof body.key !== "string")
      throw new Error(
        `OpenRouter didn't hand out a key (HTTP ${String(response.status)}).`,
      );
    return body.key;
  } finally {
    popup.close();
  }
}

/**
 * The code `redirect.ts` passes on. Whether the popup was closed can't be
 * told (a sign-in page may cut the tie to it), so this waits until the
 * time runs out; the UI lets the user stop waiting.
 */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(OPENROUTER_CHANNEL);
    const timeout = setTimeout(() => {
      channel.close();
      reject(new Error("closed"));
    }, SIGN_IN_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent<{ code?: unknown }>) => {
      if (typeof event.data.code !== "string") return;
      channel.close();
      clearTimeout(timeout);
      resolve(event.data.code);
    };
  });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
