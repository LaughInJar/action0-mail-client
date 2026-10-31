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

/**
 * Known causes the app describes itself, so the interface can say them in
 * its language (with {@link MailError.params}). Errors without a reason
 * show their message as it is (e.g. the provider's own text). Sign-in
 * reasons name the provider in `params.provider` ("Google" if absent).
 */
export type MailErrorReason =
  | "notConnected"
  | "signInAgain"
  | "signInUnavailable"
  | "signInFailed"
  | "noPlayServices"
  | "signInClosed"
  | "signInBlocked"
  | "accessNotGranted"
  | "unreachable"
  | "tokenRejected"
  | "draftGone"
  | "noContent"
  | "onlyTrashSpam"
  | "notALabel"
  | "notACategory"
  | "categoryRename"
  | "categoryExists"
  | "categoryNeedsName"
  | "labelNeedsName"
  | "labelNoSlash"
  | "labelExists"
  | "labelNotAllowed"
  | "labelInsideItself"
  | "systemMailbox"
  | "settingsNotAllowed"
  | "peopleApiDisabled"
  | "contactsDeclined"
  | "senderUnreachable"
  | "senderRefused"
  | "needsHttps"
  | "demoRefused"
  | "demoContactsOff"
  | "adminApprovalNeeded"
  | "noArchiveFolder"
  | "notAFolder"
  | "folderNeedsName"
  | "folderExists"
  | "folderInsideItself"
  | "mailTooBig"
  | "mailRejected"
  | "sendAsDenied"
  | "attachmentUploadBlocked"
  | "attachmentUploadInterrupted"
  | "wrongAccount"
  | "peopleUnavailable"
  | "calendarAccessNeeded"
  | "icsBlocked"
  | "icsNotFound"
  | "icsUnreadable"
  | "icsBadUrl"
  | "calendarReadOnly"
  | "eventGone"
  | "eventChanged"
  | "calendarLoginRefused"
  | "calendarServerMissing"
  | "noFilterServer"
  | "filterExists"
  | "filtersChanged"
  | "forwardNotAllowed"
  | "filterNeedsCondition"
  | "filterNeedsAction";

/** The only error type that providers and auth sessions reject with. */
export class MailError extends Error {
  override readonly name = "MailError";
  readonly code: MailErrorCode;
  /** HTTP status, if the error came from an HTTP response. */
  readonly status: number | undefined;
  /** A cause the interface can describe in its own language. */
  readonly reason: MailErrorReason | undefined;
  /** Values for the description of {@link reason} (a label's name, …). */
  readonly params: Readonly<Record<string, string>>;

  constructor(
    code: MailErrorCode,
    message: string,
    options: {
      status?: number;
      cause?: unknown;
      reason?: MailErrorReason;
      params?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.reason = options.reason;
    this.params = options.params ?? {};
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
