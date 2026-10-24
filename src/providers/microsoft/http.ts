import type { AuthSession } from "../../auth/types";
import { MailError } from "../../core/errors";
import { createLimiter, type Limiter } from "../../lib/limiter";
import { sleep as defaultSleep } from "../../lib/sleep";
import type { GraphErrorBody } from "./types";

/** Base URL of Microsoft Graph (v1.0). */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0/";

/** Graph handles at most this many requests per `$batch` call. */
export const BATCH_LIMIT = 20;

/**
 * Message IDs that survive moves between folders, and a sent draft keeps
 * its ID in Sent Items. Sent with every request.
 */
const IMMUTABLE_IDS = 'IdType="ImmutableId"';

/** Query parameter values. */
export type QueryParams = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/** One request of a {@link GraphHttp.batch}. */
export interface BatchRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path below {@link GRAPH_BASE}, e.g. `me/messages/{id}/move`. */
  readonly path: string;
  readonly body?: unknown;
}

/** Answer to one {@link BatchRequest}: the parsed body, or the error. */
export type BatchResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly error: MailError };

/** Options of {@link GraphHttp}. */
export interface GraphHttpOptions {
  readonly auth: AuthSession;
  /**
   * Where tokens come from instead of `auth.getAccessToken()`, e.g. a token
   * with calendar scopes.
   */
  readonly token?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** Requests in flight at the same time (Outlook allows 4 per mailbox). */
  readonly maxConcurrent?: number;
  /** Attempts per request, including the first one. */
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

interface BatchResponseItem {
  readonly id: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * Thin, typed client for Microsoft Graph.
 *
 * - Adds the bearer token and asks for immutable message IDs.
 * - Limits concurrency, because Outlook throttles per mailbox.
 * - Retries 429, 503 and 504 (honoring `Retry-After`), also per request of
 *   a `$batch`.
 * - Translates failures into {@link MailError}s; on 401 it marks the session
 *   expired.
 */
export class GraphHttp {
  readonly #auth: AuthSession;
  readonly #token: () => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #limit: Limiter;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GraphHttpOptions) {
    this.#auth = options.auth;
    this.#token = options.token ?? (() => options.auth.getAccessToken());
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#limit = createLimiter(options.maxConcurrent ?? 4);
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** The URL of a path below {@link GRAPH_BASE}, with query parameters. */
  url(path: string, params?: QueryParams): URL {
    const url = new URL(path, GRAPH_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  /**
   * GETs a path (or a full Graph URL such as an `@odata.nextLink`) and
   * returns the parsed JSON. `prefer` adds to the `Prefer` header.
   */
  get<T>(
    path: string | URL,
    params?: QueryParams,
    signal?: AbortSignal,
    prefer?: string,
  ): Promise<T> {
    const url = typeof path === "string" ? this.url(path, params) : path;
    if (!url.href.startsWith(GRAPH_BASE))
      return Promise.reject(
        new MailError("provider", `Not a Microsoft Graph URL: ${url.host}`),
      );
    return this.#limit(() =>
      this.#json<T>(url, "GET", undefined, signal, true, prefer),
    );
  }

  /** GETs raw bytes (an attachment's `$value`). */
  async getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    return this.#limit(async () => {
      const response = await this.#exchange(
        this.url(path),
        "GET",
        undefined,
        signal,
        true,
      );
      return response.blob();
    });
  }

  /**
   * POSTs a JSON body (none if `undefined`) and returns the parsed response
   * (`undefined` for an empty one). Requests that create something pass
   * `retry: false`: after a network error or a 5xx the first attempt may
   * have succeeded.
   */
  post<T = undefined>(
    path: string,
    body: unknown,
    {
      retry = true,
      signal,
      prefer,
    }: { retry?: boolean; signal?: AbortSignal; prefer?: string } = {},
  ): Promise<T> {
    return this.#limit(() =>
      this.#json<T>(this.url(path), "POST", body, signal, retry, prefer),
    );
  }

  /** PATCHes a resource with the changed fields and returns it. */
  patch<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    prefer?: string,
  ): Promise<T> {
    return this.#limit(() =>
      this.#json<T>(this.url(path), "PATCH", body, signal, true, prefer),
    );
  }

  /** DELETEs a resource. */
  async delete(path: string, signal?: AbortSignal): Promise<void> {
    await this.#limit(() =>
      this.#exchange(this.url(path), "DELETE", undefined, signal, true),
    );
  }

  /**
   * Runs requests through `$batch`, {@link BATCH_LIMIT} per call, and
   * returns one result per request in the same order. Throttled requests
   * are repeated after `Retry-After`; other failures are returned, not
   * thrown, so callers decide what a partial failure means.
   */
  async batch<T>(
    requests: readonly BatchRequest[],
    signal?: AbortSignal,
  ): Promise<BatchResult<T>[]> {
    const results: BatchResult<T>[] = [];
    for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
      results.push(
        ...(await this.#batchChunk<T>(
          requests.slice(start, start + BATCH_LIMIT),
          signal,
        )),
      );
    }
    return results;
  }

  /**
   * PUTs one chunk of an upload session. The URL is pre-authorized by
   * Microsoft, so it gets no token. Resolves to the response (JSON bodies
   * are small).
   */
  async putChunk(
    uploadUrl: string,
    chunk: Blob,
    range: { readonly start: number; readonly total: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const end = range.start + chunk.size - 1;
    let response: Response;
    try {
      response = await this.#fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${String(range.start)}-${String(end)}/${String(range.total)}`,
        },
        body: chunk,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new MailError("network", "Could not upload to Outlook.", {
        cause,
      });
    }
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new MailError(
        "provider",
        `Outlook: ${body.error?.message ?? response.statusText}`,
        { status: response.status, cause: body },
      );
    }
  }

  async #batchChunk<T>(
    requests: readonly BatchRequest[],
    signal: AbortSignal | undefined,
  ): Promise<BatchResult<T>[]> {
    const results = new Map<number, BatchResult<T>>();
    let pending = requests.map((request, index) => ({ request, index }));
    for (let attempt = 1; pending.length > 0; attempt++) {
      const answer = await this.#limit(() =>
        this.#json<{ responses?: BatchResponseItem[] }>(
          this.url("$batch"),
          "POST",
          {
            requests: pending.map(({ request, index }) => ({
              id: String(index),
              method: request.method,
              url: `/${request.path}`,
              headers: {
                Prefer: IMMUTABLE_IDS,
                ...(request.body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              },
              ...(request.body === undefined ? {} : { body: request.body }),
            })),
          },
          signal,
          true,
        ),
      );
      const byId = new Map(
        (answer.responses ?? []).map((item) => [item.id, item]),
      );
      const retry: typeof pending = [];
      let wait = 0;
      for (const entry of pending) {
        const item = byId.get(String(entry.index));
        const status = item?.status ?? 500;
        if (status >= 200 && status < 300) {
          results.set(entry.index, { ok: true, body: item?.body as T });
          continue;
        }
        const throttled = status === 429 || status === 503 || status === 504;
        if (throttled && attempt < this.#maxAttempts) {
          retry.push(entry);
          wait = Math.max(
            wait,
            retryAfterMs(item?.headers?.["Retry-After"]) ??
              this.#backoff(attempt),
          );
          continue;
        }
        if (status === 401) this.#auth.markExpired();
        results.set(entry.index, {
          ok: false,
          error: toMailError(status, item?.body ?? {}),
        });
      }
      pending = retry;
      if (pending.length > 0) await this.#sleep(wait, signal);
    }
    return requests.map(
      (_request, index) =>
        results.get(index) ?? {
          ok: false,
          error: new MailError("provider", "Outlook: no answer"),
        },
    );
  }

  async #json<T>(
    url: URL,
    method: "GET" | "POST" | "PATCH",
    body: unknown,
    signal: AbortSignal | undefined,
    retry: boolean,
    prefer?: string,
  ): Promise<T> {
    const response = await this.#exchange(
      url,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      signal,
      retry,
      prefer,
    );
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** Sends a request (with retries) and returns the successful response. */
  async #exchange(
    url: URL,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    payload: string | undefined,
    signal: AbortSignal | undefined,
    retry: boolean,
    prefer?: string,
  ): Promise<Response> {
    const maxAttempts = retry ? this.#maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const token = await this.#token();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: prefer ? `${IMMUTABLE_IDS}, ${prefer}` : IMMUTABLE_IDS,
            ...(payload === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: payload }),
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (attempt < maxAttempts) {
          await this.#sleep(this.#backoff(attempt), signal);
          continue;
        }
        throw new MailError("network", "Could not reach Outlook.", {
          cause,
          reason: "unreachable",
          params: { service: "Outlook" },
        });
      }

      if (response.ok) return response;
      const status = response.status;
      const body = await readErrorBody(response);

      if (status === 401) {
        this.#auth.markExpired();
        throw new MailError(
          "auth-required",
          "Outlook rejected the access token.",
          {
            status,
            reason: "tokenRejected",
            params: { service: "Outlook" },
          },
        );
      }
      // 429 means "not processed", so even creating requests may repeat it.
      const retryable =
        status === 429 || (retry && (status === 503 || status === 504));
      if (retryable && attempt < this.#maxAttempts) {
        await this.#sleep(
          retryAfterMs(response.headers.get("Retry-After")) ??
            this.#backoff(attempt),
          signal,
        );
        continue;
      }
      throw toMailError(status, body);
    }
  }

  #backoff(attempt: number): number {
    return 500 * 2 ** (attempt - 1) + Math.floor(this.#random() * 250);
  }
}

/** A Graph error answer as a {@link MailError} (its `cause` is the body). */
export function toMailError(status: number, body: GraphErrorBody): MailError {
  const message = `Outlook: ${body.error?.message ?? `HTTP ${String(status)}`}`;
  const code =
    status === 401
      ? "auth-required"
      : status === 404
        ? "not-found"
        : status === 429
          ? "rate-limited"
          : "provider";
  return new MailError(code, message, { status, cause: body });
}

/** Graph's error code (`ErrorItemNotFound`, …) of a failed request, if any. */
export function graphErrorCode(error: unknown): string | undefined {
  if (!(error instanceof MailError)) return undefined;
  const cause = error.cause as GraphErrorBody | undefined;
  return cause?.error?.code;
}

async function readErrorBody(response: Response): Promise<GraphErrorBody> {
  try {
    return (await response.json()) as GraphErrorBody;
  } catch {
    return {};
  }
}

function retryAfterMs(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
