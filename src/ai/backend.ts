/**
 * Where AI keys and sign-ins live and how requests reach the services: in
 * the web app the browser keeps keys (sessionStorage, or localStorage when
 * the user asks to remember one) and sends the requests itself; in the
 * apps the native side keeps them in its vault and adds them to each
 * request, so they never reach the web view.
 */
import type { AiServiceConfig } from "./types";

/** A request to a service, without its key. */
export interface AiHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The services that have a key or sign-in. */
export interface AiCredentials {
  /** By service id. */
  readonly ids: ReadonlySet<string>;
  /**
   * They're kept beyond this run (apps: the OS keychain holds the vault's
   * key). Always true in the web app, where Remember decides per key.
   */
  readonly persistent: boolean;
}

/** See the module docs. */
export interface AiBackend {
  /** `browser`: keys in browser storage; `vault`: the apps' vault. */
  readonly keeps: "browser" | "vault";
  readonly credentials: () => Promise<AiCredentials>;
  /**
   * Sends the request with the service's key or sign-in added. The
   * response's body streams. Rejects (TypeError) when there's no answer.
   */
  readonly send: (
    service: AiServiceConfig,
    request: AiHttpRequest,
    signal?: AbortSignal,
  ) => Promise<Response>;
  readonly saveKey: (service: AiServiceConfig, key: string) => Promise<void>;
  /** Drops the key or sign-in (a ChatGPT sign-in is revoked too). */
  readonly forget: (service: AiServiceConfig) => Promise<void>;
  /** Web: moves the key between sessionStorage and localStorage. */
  readonly setRemember?: (service: AiServiceConfig, remember: boolean) => void;
  readonly signIn: {
    /** Signs in at OpenRouter, which hands out a key; it's kept here. */
    readonly openrouter: (service: AiServiceConfig) => Promise<void>;
    /** Signs in with ChatGPT (the apps only): who signed in. */
    readonly chatgpt?: (
      service: AiServiceConfig,
    ) => Promise<{ readonly account: string }>;
  };
}
