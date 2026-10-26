/**
 * The AI assistant's backend in the apps: keys and ChatGPT sign-ins stay
 * in the native side's vault (`src-tauri/src/ai`), which adds them to each
 * request, only for the address they belong to. Answers stream back
 * through a Tauri channel: the status and headers, the body's chunks as
 * raw bytes, then the end.
 */
import { Channel } from "@tauri-apps/api/core";
import type { AiBackend } from "../../ai/backend";
import { AI_KINDS, serviceBaseUrl } from "../../ai/kinds";
import { toNativeError, type SignedInPage } from "./authBridge";
import type { Invoke } from "./nativeFetch";

/** A message of `ai_request`'s channel: an event, or a chunk of the body. */
export type AiEvent =
  | {
      readonly kind: "head";
      readonly status: number;
      readonly statusText: string;
      readonly headers: readonly (readonly [string, string])[];
    }
  | { readonly kind: "end" }
  | { readonly kind: "error"; readonly message: string }
  | ArrayBuffer;

/** Makes the channel `ai_request` streams into (Tauri's; tests pass a fake). */
export type AiChannelFactory = (onMessage: (event: AiEvent) => void) => unknown;

const tauriChannel: AiChannelFactory = (onMessage) =>
  new Channel<AiEvent>(onMessage);

/** Statuses whose responses have no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The native {@link AiBackend}. Sign-ins reject with the native side's
 * refusal (`NativeAuthError`: cancelled, denied, network, provider, …).
 */
export function createNativeAiBackend(
  invoke: Invoke,
  page: () => SignedInPage,
  channel: AiChannelFactory = tauriChannel,
): AiBackend {
  let next = 0;
  const signIn = async <T>(command: string, id: string): Promise<T> => {
    try {
      return await invoke<T>(command, { id, page: page() });
    } catch (error) {
      throw toNativeError(error);
    }
  };

  return {
    keeps: "vault",
    credentials: async () => {
      const kept = await invoke<{ persistent: boolean; ids: string[] }>(
        "ai_secrets",
      );
      return { persistent: kept.persistent, ids: new Set(kept.ids) };
    },
    saveKey: async (service, key) => {
      const header = AI_KINDS[service.kind].keyHeader;
      if (!header) throw new Error(`${service.kind} takes no key.`);
      await invoke("ai_save_key", {
        id: service.id,
        key,
        base: serviceBaseUrl(service),
        header,
      });
    },
    forget: async (service) => {
      await invoke("ai_forget", { id: service.id });
    },
    signIn: {
      openrouter: async (service) => {
        await signIn<unknown>("ai_openrouter_sign_in", service.id);
      },
      chatgpt: (service) =>
        signIn<{ account: string }>("ai_chatgpt_sign_in", service.id),
    },
    send: (service, request, signal) =>
      new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        const requestId = (next = (next + 1) % 2 ** 31);
        const abort = () => {
          void invoke("ai_abort", { requestId }).catch(() => undefined);
        };
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            body = controller;
          },
          cancel: abort,
        });
        // The response was handed out (the head came); the body ended.
        let answered = false;
        let ended = false;
        const fail = (error: Error) => {
          if (!answered) {
            answered = true;
            reject(error);
          } else if (!ended) {
            ended = true;
            body?.error(error);
          }
        };
        const onEvent = channel((event) => {
          // Chunks are raw bytes (an ArrayBuffer, maybe of another realm).
          if (!("kind" in event)) {
            if (!ended) body?.enqueue(new Uint8Array(event));
          } else if (event.kind === "head") {
            answered = true;
            resolve(
              new Response(NO_BODY.has(event.status) ? null : stream, {
                status: event.status,
                statusText: event.statusText,
                headers: event.headers.map(
                  ([name, value]): [string, string] => [name, value],
                ),
              }),
            );
          } else if (event.kind === "end") {
            if (!ended) {
              ended = true;
              body?.close();
            }
          } else {
            fail(new TypeError(`The answer broke off: ${event.message}`));
          }
        });
        const onAbort = () => {
          abort();
          fail(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // The command settles once the answer is complete; the body ends
        // with the channel's own end event, which may come later.
        invoke("ai_request", {
          id: service.id,
          request: {
            requestId,
            method: request.method,
            url: request.url,
            headers: Object.entries(request.headers),
          },
          body: request.body ?? null,
          onEvent,
        })
          .catch((error: unknown) => {
            fail(
              signal?.aborted
                ? abortError(signal)
                : new TypeError(`Failed to fetch: ${String(error)}`, {
                    cause: error,
                  }),
            );
          })
          .finally(() => {
            signal?.removeEventListener("abort", onAbort);
          });
      }),
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted.", "AbortError");
}
