/**
 * The calendar server (CalDAV) bridge over the apps' native side
 * (`src-tauri/src/caldav`): JSON commands for finding and connecting
 * servers, and requests framed like `nativeFetch`'s, with the final URL
 * after redirects in the answer's metadata.
 */
import type { CalendarServerInfo } from "../../accounts/calendarServer";
import type { CaldavBridge, DavResponse } from "../../providers/caldav/bridge";
import { toMailServerError } from "./imap";
import type { Invoke } from "./nativeFetch";

/** Header with a request's metadata. */
const REQUEST_HEADER = "x-a0-caldav";

/** See the module docs. */
export function createNativeCaldavBridge(invoke: Invoke): CaldavBridge {
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
  let next = 0;

  return {
    discover: (address, mailHost) =>
      call("caldav_discover", { address, mailHost: mailHost ?? null }),
    connect: (setup) => call("caldav_connect", { setup }),
    servers: () => call<CalendarServerInfo[]>("caldav_servers"),
    remove: (key) => call("caldav_remove", { key }),
    forgetCertificate: (key) => call("caldav_forget_certificate", { key }),
    request: async (key, request, signal) => {
      if (signal?.aborted) throw abortError(signal);
      const id = (next = (next + 1) % 2 ** 31);
      const meta = encodeURIComponent(
        JSON.stringify({
          key,
          id,
          method: request.method,
          url: request.url,
          headers: Object.entries(request.headers ?? {}),
        }),
      );
      const abort = () => {
        void invoke("caldav_abort", { id }).catch(() => undefined);
      };
      signal?.addEventListener("abort", abort);
      try {
        const raw = await call<ArrayBuffer>(
          "caldav_request",
          new TextEncoder().encode(request.body ?? ""),
          { headers: { [REQUEST_HEADER]: meta } },
        );
        return toDavResponse(raw);
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

/** `[u32 meta length][meta JSON][body]` as a {@link DavResponse}. */
export function toDavResponse(raw: ArrayBuffer): DavResponse {
  const bytes = new Uint8Array(raw);
  const length = new DataView(raw).getUint32(0);
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + length)),
  ) as {
    status: number;
    headers: [string, string][];
    url: string;
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of meta.headers) {
    const lower = name.toLowerCase();
    // Repeated headers (DAV) join like the Fetch API's.
    headers[lower] =
      lower in headers ? `${headers[lower] ?? ""}, ${value}` : value;
  }
  return {
    status: meta.status,
    url: meta.url,
    headers,
    body: new TextDecoder().decode(bytes.subarray(4 + length)),
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted.", "AbortError");
}
