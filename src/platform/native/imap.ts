/**
 * The IMAP/SMTP bridge over the apps' native side (`src-tauri/src/imap`):
 * JSON commands, and raw bytes for messages and attachments (like
 * `nativeFetch`), so 25 MB mails don't cross as JSON number arrays.
 */
import {
  MailServerError,
  type MailServerAccountInfo,
  type MailServerCertificate,
  type MailServerErrorKind,
} from "../../accounts/mailServer";
import type { ImapBridge } from "../../providers/imap/bridge";
import type { SignedInPage } from "./authBridge";
import type { Invoke } from "./nativeFetch";

/** Header with an append's or a send's metadata. */
const META_HEADER = "x-a0-imap";

/**
 * What the native side rejects with (`{kind, message, server?,
 * certificate?}`), as a {@link MailServerError}; Tauri's own failures (a
 * missing command) become `server` errors.
 */
export function toMailServerError(error: unknown): MailServerError {
  if (typeof error === "object" && error !== null) {
    const { kind, message, server, certificate } = error as Record<
      string,
      unknown
    >;
    if (typeof kind === "string")
      return new MailServerError(
        kind as MailServerErrorKind,
        typeof message === "string" ? message : "",
        {
          ...(server === "imap" || server === "smtp" || server === "caldav"
            ? { server }
            : {}),
          ...(typeof certificate === "object" && certificate !== null
            ? { certificate: certificate as MailServerCertificate }
            : {}),
        },
      );
  }
  return new MailServerError(
    "server",
    error instanceof Error ? error.message : String(error),
  );
}

/** See the module docs. */
export function createNativeImapBridge(
  invoke: Invoke,
  page: () => SignedInPage,
): ImapBridge {
  const call = async <T>(
    command: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { readonly headers?: Record<string, string> },
  ): Promise<T> => {
    try {
      return await invoke<T>(command, args, options);
    } catch (error) {
      throw toMailServerError(error);
    }
  };
  const withMeta = (meta: object) => ({
    headers: { [META_HEADER]: encodeURIComponent(JSON.stringify(meta)) },
  });

  return {
    discover: (address) => call("imap_discover", { address }),
    connect: (setup) => call("imap_connect", { setup, page: page() }),
    accounts: () =>
      call<{ persistent: boolean; accounts: MailServerAccountInfo[] }>(
        "imap_accounts",
      ),
    reconnect: (key, password) =>
      call("imap_reconnect", { key, password: password ?? null, page: page() }),
    remove: (key) => call("imap_remove", { key }),
    forgetCertificate: (key) => call("imap_forget_certificate", { key }),
    call: (key, name, request, signal) => {
      if (signal?.aborted) return Promise.reject(signal.reason as Error);
      // The native side finishes the operation; an aborted caller ignores it.
      return call("imap_call", { key, name, request });
    },
    bytes: async (key, request, signal) => {
      if (signal?.aborted) throw signal.reason as Error;
      const raw = await call<ArrayBuffer>("imap_bytes", { key, request });
      return new Uint8Array(raw);
    },
    append: (key, folder, message) =>
      call("imap_append", message, withMeta({ key, ...folder })),
    send: (key, envelope, message) =>
      call("imap_send", message, withMeta({ key, ...envelope })),
  };
}
