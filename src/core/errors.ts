/**
 * Failure categories the UI can react to:
 * - `auth-required`: the user has to sign in again (interactively).
 * - `not-found`: the message or mailbox no longer exists.
 * - `rate-limited`: the provider throttled us and retries ran out.
 * - `network`: the request never got a response.
 * - `unavailable`: the account can't do this right now, e.g. an optional
 *   service isn't enabled or its permission was declined.
 * - `provider`: any other error reported by the provider.
 */
export type MailErrorCode =
  | "auth-required"
  | "not-found"
  | "rate-limited"
  | "network"
  | "unavailable"
  | "provider";

/** The only error type that providers and auth sessions reject with. */
export class MailError extends Error {
  override readonly name = "MailError";
  readonly code: MailErrorCode;
  /** HTTP status, if the error came from an HTTP response. */
  readonly status: number | undefined;

  constructor(
    code: MailErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.status = options.status;
  }
}

/** Narrows `error` to a {@link MailError}, optionally of a specific code. */
export function isMailError(
  error: unknown,
  code?: MailErrorCode,
): error is MailError {
  return (
    error instanceof MailError && (code === undefined || error.code === code)
  );
}
