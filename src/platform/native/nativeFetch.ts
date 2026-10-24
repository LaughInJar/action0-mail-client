/**
 * `fetch` for the desktop app: the request is made by the native side, so
 * CORS doesn't apply and the web view itself needs no network access.
 * Bodies cross as raw bytes (see `src-tauri/src/net.rs`).
 */

/** Sends a command to the native side (Tauri's `invoke`). */
export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
  options?: { readonly headers?: Record<string, string> },
) => Promise<T>;

/** Header with the request's metadata. */
const REQUEST_HEADER = "x-a0-request";

/** Bodies that statuses don't allow. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/** A `fetch` over the native side's `net_fetch` command. */
export function createNativeFetch(invoke: Invoke): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError(signal);
    // Normalizes what fetch accepts (URL, Request, bodies of any kind).
    const request = new Request(input, { ...init, signal: null });
    const body = new Uint8Array(await request.arrayBuffer());
    const id = (next = (next + 1) % 2 ** 31);
    const meta = encodeURIComponent(
      JSON.stringify({
        id,
        method: request.method,
        url: request.url,
        headers: [...request.headers],
      }),
    );
    const abort = () => {
      void invoke("net_abort", { id }).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort);
    let raw: ArrayBuffer;
    try {
      raw = await invoke<ArrayBuffer>("net_fetch", body, {
        headers: { [REQUEST_HEADER]: meta },
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw new TypeError(`Failed to fetch: ${String(error)}`, {
        cause: error,
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    return toResponse(raw);
  };
}

/** `[u32 meta length][meta JSON][body]` as a {@link Response}. */
export function toResponse(raw: ArrayBuffer): Response {
  const bytes = new Uint8Array(raw);
  const length = new DataView(raw).getUint32(0);
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + length)),
  ) as {
    status: number;
    statusText: string;
    headers: [string, string][];
  };
  const body = bytes.subarray(4 + length);
  return new Response(NO_BODY.has(meta.status) ? null : body, {
    status: meta.status,
    statusText: meta.statusText,
    headers: meta.headers,
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted.", "AbortError");
}
