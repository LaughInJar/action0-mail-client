import { MailError } from "../core/errors";

/**
 * Sends the RFC 8058 one-click unsubscribe POST from the browser. The
 * request carries no cookies and no referrer. Cross-site answers are opaque
 * (`no-cors`), so only "the sender was reached" can be told apart from a
 * network failure; a readable error status counts as a failure too.
 */
export async function sendOneClickUnsubscribe(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  if (!url.startsWith("https:"))
    throw new MailError("provider", "One-click unsubscribe needs https.");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new MailError("network", "The sender’s server couldn’t be reached.", {
      cause,
    });
  }
  if (response.type !== "opaque" && !response.ok)
    throw new MailError(
      "provider",
      `The sender’s server refused (${response.status}).`,
      { status: response.status },
    );
}
