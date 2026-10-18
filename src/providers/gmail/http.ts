import type { AuthSession } from "../../auth/types";
import { MailError } from "../../core/errors";
import { createLimiter, type Limiter } from "../../lib/limiter";
import { sleep as defaultSleep } from "../../lib/sleep";
import type { GoogleApiErrorBody } from "./types";

/** Base URL of the authenticated user's Gmail API resources. */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";

/** Base URL for media uploads (raw messages) to the same resources. */
export const GMAIL_UPLOAD_BASE =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/";

/** Base URL of the Google People API (contacts). */
export const PEOPLE_API_BASE = "https://people.googleapis.com/v1/";

/** Query parameter values; arrays become repeated parameters. */
export type QueryParams = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>;

/** Options of {@link GmailHttp}. */
export interface GmailHttpOptions {
  readonly auth: AuthSession;
  /** API base for relative paths; defaults to {@link GMAIL_API_BASE}. */
  readonly baseUrl?: string;
  /** Name used in error messages. */
  readonly service?: string;
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
  readonly #base: string;
  readonly #service: string;
  readonly #fetch: typeof fetch;
  readonly #limit: Limiter;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GmailHttpOptions) {
    this.#auth = options.auth;
    this.#base = options.baseUrl ?? GMAIL_API_BASE;
    this.#service = options.service ?? "Gmail";
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#limit = createLimiter(options.maxConcurrent ?? 10);
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** GETs `path` (relative to the base URL) and returns the parsed JSON. */
  get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, this.#base);
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

  /** DELETEs `path`. */
  delete(path: string, signal?: AbortSignal): Promise<undefined> {
    const url = new URL(path, this.#base);
    return this.#limit(() =>
      this.#request<undefined>(url, "DELETE", undefined, signal),
    );
  }

  /**
   * Uploads a raw RFC 5322 message with JSON metadata (`uploadType=multipart`)
   * to `path` below {@link GMAIL_UPLOAD_BASE}. Requests that create something
   * (`retry: false`) aren't repeated after a network error or a 5xx, because
   * the first attempt may have succeeded.
   */
  upload<T>(
    method: "POST" | "PUT",
    path: string,
    metadata: unknown,
    raw: string,
    { retry, signal }: { retry: boolean; signal?: AbortSignal | undefined },
  ): Promise<T> {
    const url = new URL(path, GMAIL_UPLOAD_BASE);
    url.searchParams.set("uploadType", "multipart");
    const boundary = `a0_upload_${Math.floor(this.#random() * 1e12).toString(36)}`;
    const payload = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "",
      raw,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return this.#limit(() =>
      this.#request<T>(
        url,
        method,
        { payload, contentType: `multipart/related; boundary=${boundary}` },
        signal,
        retry,
      ),
    );
  }

  /**
   * POSTs a JSON body to `path` and returns the parsed JSON response
   * (`undefined` for 204 No Content). Only use it for idempotent operations,
   * because failed attempts are retried.
   */
  post<T = undefined>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, this.#base);
    // Some endpoints (messages.trash) require an empty body.
    const payload =
      body === undefined
        ? undefined
        : { payload: JSON.stringify(body), contentType: "application/json" };
    return this.#limit(() => this.#request<T>(url, "POST", payload, signal));
  }

  async #request<T>(
    url: URL,
    method: "GET" | "POST" | "PUT" | "DELETE",
    content: { payload: string; contentType: string } | undefined,
    signal: AbortSignal | undefined,
    retry = true,
  ): Promise<T> {
    const maxAttempts = retry ? this.#maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const token = await this.#auth.getAccessToken();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(content === undefined
              ? {}
              : { "Content-Type": content.contentType }),
          },
          ...(content === undefined ? {} : { body: content.payload }),
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (attempt < maxAttempts) {
          await this.#sleep(this.#backoff(attempt), signal);
          continue;
        }
        throw new MailError("network", `Could not reach ${this.#service}.`, {
          cause,
        });
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
          `${this.#service} rejected the access token.`,
          {
            status,
          },
        );
      }
      if (status === 404) {
        throw new MailError("not-found", `${this.#service}: ${message}`, {
          status,
        });
      }

      const rateLimited =
        status === 429 ||
        (status === 403 &&
          (body.error?.errors ?? []).some((e) =>
            RATE_LIMIT_REASONS.has(e.reason ?? ""),
          ));
      // 429 means "not processed", so even creating requests may repeat it.
      const retryable =
        status === 429 || (retry && (rateLimited || status >= 500));
      if (retryable && attempt < this.#maxAttempts) {
        await this.#sleep(
          retryAfterMs(response) ?? this.#backoff(attempt),
          signal,
        );
        continue;
      }
      throw new MailError(
        rateLimited ? "rate-limited" : "provider",
        `${this.#service}: ${message}`,
        {
          status,
          cause: body,
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
