import type { AuthSession } from "../../auth/types";
import { MailError } from "../../core/errors";
import { createLimiter, type Limiter } from "../../lib/limiter";
import { sleep as defaultSleep } from "../../lib/sleep";
import type { GoogleApiErrorBody } from "./types";

/** Base URL of the authenticated user's Gmail API resources. */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";

/** Query parameter values; arrays become repeated parameters. */
export type QueryParams = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>;

/** Options of {@link GmailHttp}. */
export interface GmailHttpOptions {
  readonly auth: AuthSession;
  readonly fetch?: typeof fetch;
  /** Requests in flight at the same time (per account). */
  readonly maxConcurrent?: number;
  /** Attempts per request, including the first one. */
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/**
 * Thin, typed client for the Gmail REST API.
 *
 * - Adds the bearer token from the {@link AuthSession}.
 * - Limits concurrency, because Gmail enforces per-user quotas.
 * - Retries 429, 5xx and rate-limit 403s with exponential backoff (honoring
 *   `Retry-After`).
 * - Translates failures into {@link MailError}s; on 401 it marks the session
 *   expired.
 */
export class GmailHttp {
  readonly #auth: AuthSession;
  readonly #fetch: typeof fetch;
  readonly #limit: Limiter;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GmailHttpOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#limit = createLimiter(options.maxConcurrent ?? 10);
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** GETs `path` (relative to {@link GMAIL_API_BASE}) and returns the parsed JSON. */
  get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, GMAIL_API_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value as readonly string[])
          url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return this.#limit(() => this.#request<T>(url, "GET", undefined, signal));
  }

  /**
   * POSTs a JSON body to `path` and returns the parsed JSON response
   * (`undefined` for 204 No Content). Only use it for idempotent operations,
   * because failed attempts are retried.
   */
  post<T = undefined>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, GMAIL_API_BASE);
    return this.#limit(() =>
      this.#request<T>(url, "POST", JSON.stringify(body), signal),
    );
  }

  async #request<T>(
    url: URL,
    method: "GET" | "POST",
    payload: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.#auth.getAccessToken();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: payload }),
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (attempt < this.#maxAttempts) {
          await this.#sleep(this.#backoff(attempt), signal);
          continue;
        }
        throw new MailError("network", "Could not reach Gmail.", { cause });
      }

      if (response.ok) {
        // Some endpoints (batchModify) answer with an empty body.
        const text = await response.text();
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }

      const body = await readErrorBody(response);
      const message = body.error?.message ?? response.statusText;
      const status = response.status;

      if (status === 401) {
        this.#auth.markExpired();
        throw new MailError(
          "auth-required",
          "Gmail rejected the access token.",
          {
            status,
          },
        );
      }
      if (status === 404) {
        throw new MailError("not-found", `Gmail: ${message}`, { status });
      }

      const rateLimited =
        status === 429 ||
        (status === 403 &&
          (body.error?.errors ?? []).some((e) =>
            RATE_LIMIT_REASONS.has(e.reason ?? ""),
          ));
      if ((rateLimited || status >= 500) && attempt < this.#maxAttempts) {
        await this.#sleep(
          retryAfterMs(response) ?? this.#backoff(attempt),
          signal,
        );
        continue;
      }
      throw new MailError(
        rateLimited ? "rate-limited" : "provider",
        `Gmail: ${message}`,
        {
          status,
        },
      );
    }
  }

  #backoff(attempt: number): number {
    return 500 * 2 ** (attempt - 1) + Math.floor(this.#random() * 250);
  }
}

async function readErrorBody(response: Response): Promise<GoogleApiErrorBody> {
  try {
    return (await response.json()) as GoogleApiErrorBody;
  } catch {
    return {};
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
