/**
 * What the protocols share: sending through the backend, and turning the
 * services' error answers into {@link AiError}s.
 */
import type { AiHttpRequest } from "../backend";
import { AiError, type AiErrorKind } from "../types";
import type { AiModel, AiRequest, AiServiceConfig } from "../types";

/** Sends a request with the service's key (bound to backend and service). */
export type Send = (
  request: AiHttpRequest,
  signal?: AbortSignal,
) => Promise<Response>;

/** A wire protocol: listing models and writing an answer. */
export interface Protocol {
  readonly models: (
    send: Send,
    service: AiServiceConfig,
    signal?: AbortSignal,
  ) => Promise<AiModel[]>;
  readonly write: (
    send: Send,
    service: AiServiceConfig,
    request: AiRequest,
    signal: AbortSignal,
  ) => AsyncGenerator<string>;
}

/** Sends, and throws an {@link AiError} for no answer or an error status. */
export async function call(
  send: Send,
  request: AiHttpRequest,
  signal: AbortSignal | undefined,
  options: { readonly signIn?: boolean } = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await send(request, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AiError(
      "unreachable",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (!response.ok) throw await responseError(response, options);
  return response;
}

/** The JSON of a successful answer. */
export async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new AiError(
      "other",
      "The service sent an answer action0 can't read.",
      {
        cause: error,
      },
    );
  }
}

/** A streamed event's JSON, or undefined if it isn't any. */
export function parseEvent(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** The body of a streaming answer. */
export function streamOf(response: Response): ReadableStream<Uint8Array> {
  if (!response.body)
    throw new AiError("other", "The service sent an empty answer.");
  return response.body;
}

interface ErrorDetails {
  readonly message: string;
  readonly code: string;
}

/**
 * The message and code of an error answer, in the shapes the services use:
 * `{error: {message, type, code}}` (OpenAI, Anthropic, ChatGPT), a list of
 * those (Gemini), `{error: "text"}` (Ollama) or `{message}`.
 */
export function errorDetails(body: unknown): ErrorDetails {
  const first = Array.isArray(body) ? (body[0] as unknown) : body;
  const record = isRecord(first) ? first : {};
  const error = record.error;
  if (typeof error === "string") return { message: error, code: "" };
  const inner = isRecord(error) ? error : record;
  const message = typeof inner.message === "string" ? inner.message : "";
  const code = [inner.code, inner.type, inner.status]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return { message, code };
}

/** What kind of failure an error code, status and message mean. */
export function errorKind(
  status: number | undefined,
  { message, code }: ErrorDetails,
  { signIn = false }: { readonly signIn?: boolean } = {},
): AiErrorKind {
  // ChatGPT's plan errors (subscription_sharing_…).
  if (code.includes("usage_limit_exceeded")) return "limit";
  if (code.includes("not_eligible")) return "notEligible";
  if (code.includes("usage_unavailable")) return "unavailable";
  if (
    code.includes("insufficient_quota") ||
    /credit balance|insufficient credits|out of credits/i.test(message)
  )
    return "credit";
  if (code.includes("authentication_error") || status === 401)
    return signIn ? "signIn" : "key";
  if (code.includes("permission_error") || status === 403)
    return signIn ? "notEligible" : "key";
  if (status === 402) return "credit";
  if (code.includes("not_found") || status === 404) return "model";
  if (code.includes("rate_limit") || status === 429) return "limit";
  if (
    code.includes("overloaded") ||
    status === 408 ||
    (status !== undefined && status >= 500)
  )
    return "unavailable";
  return "other";
}

/** An error answer as an {@link AiError}. */
export async function responseError(
  response: Response,
  options: { readonly signIn?: boolean } = {},
): Promise<AiError> {
  const text = await response.text().catch(() => "");
  const details = errorDetails(parseEvent(text));
  return new AiError(
    errorKind(response.status, details, options),
    details.message || `HTTP ${String(response.status)}`,
    { status: response.status },
  );
}

/** An error the service sent in the middle of its answer. */
export function streamError(
  body: unknown,
  options: { readonly signIn?: boolean } = {},
): AiError {
  const details = errorDetails(body);
  return new AiError(
    errorKind(undefined, details, options),
    details.message || "The service stopped with an error.",
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
