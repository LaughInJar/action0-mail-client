import { describe, expect, it, vi } from "vitest";
import type { AiServiceConfig } from "../../ai/types";
import { NativeAuthError } from "../../auth/native/bridge";
import { createNativeAiBackend, type AiEvent } from "./ai";
import type { Invoke } from "./nativeFetch";

const claude: AiServiceConfig = { id: "s1", kind: "anthropic" };
const page = () => ({ done: "Signed in", failed: "Not signed in" });
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const head: AiEvent = {
  kind: "head",
  status: 200,
  statusText: "OK",
  headers: [["content-type", "text/event-stream"]],
};

/**
 * A native side whose `ai_request` answers through the channel with
 * `events` (after the command was sent), then settles with `outcome`.
 */
function setup(
  answer: (
    emit: (event: AiEvent) => void,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let emit: (event: AiEvent) => void = () => undefined;
  const invoke = vi.fn((command: string, args?: unknown) => {
    const record = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: record });
    if (command === "ai_request") return answer(emit, record);
    if (command === "ai_secrets")
      return Promise.resolve({ persistent: true, ids: ["s1"] });
    return Promise.resolve(undefined);
  }) as unknown as Invoke;
  const backend = createNativeAiBackend(invoke, page, (onMessage) => {
    emit = onMessage;
    return "channel";
  });
  return { backend, calls };
}

const request = {
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
} as const;

describe("the apps' AI backend", () => {
  it("streams the answer as the native side relays it", async () => {
    const { backend, calls } = setup(async (emit) => {
      emit(head);
      emit(bytes("data: hel"));
      emit(bytes("lo\n\n"));
      emit({ kind: "end" });
      await Promise.resolve();
    });
    const response = await backend.send(claude, request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: hello\n\n");
    // The key isn't the UI's to add: only the service's id goes along.
    expect(calls[0]).toEqual({
      command: "ai_request",
      args: {
        id: "s1",
        request: {
          requestId: 1,
          method: "POST",
          url: request.url,
          headers: [["content-type", "application/json"]],
        },
        body: "{}",
        onEvent: "channel",
      },
    });
  });

  it("hands out the response before the body is complete", async () => {
    let later: (event: AiEvent) => void = () => undefined;
    const { backend } = setup((emit) => {
      emit(head);
      later = emit;
      return new Promise(() => undefined);
    });
    const response = await backend.send(claude, request);
    const reader = response.body!.getReader();
    later(bytes("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    later({ kind: "end" });
    expect((await reader.read()).done).toBe(true);
  });

  it("breaks the body off when the answer does", async () => {
    const { backend } = setup((emit) => {
      emit(head);
      emit(bytes("data: a"));
      emit({ kind: "error", message: "connection reset" });
      return Promise.resolve();
    });
    const response = await backend.send(claude, request);
    await expect(response.text()).rejects.toThrow(/connection reset/);
  });

  it("rejects like fetch when there's no answer at all", async () => {
    const { backend } = setup(() =>
      Promise.reject(new Error("error sending request")),
    );
    await expect(backend.send(claude, request)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("aborts the request on the native side", async () => {
    const { backend, calls } = setup(() => new Promise(() => undefined));
    const controller = new AbortController();
    const sent = backend.send(claude, request, controller.signal);
    controller.abort();
    await expect(sent).rejects.toThrow(/abort/i);
    expect(calls.map((call) => call.command)).toEqual([
      "ai_request",
      "ai_abort",
    ]);
    expect(calls[1]?.args).toEqual({ requestId: 1 });
  });

  it("aborts when the body is no longer read", async () => {
    const { backend, calls } = setup((emit) => {
      emit(head);
      return new Promise(() => undefined);
    });
    const response = await backend.send(claude, request);
    await response.body!.cancel();
    expect(calls.at(-1)).toEqual({
      command: "ai_abort",
      args: { requestId: 1 },
    });
  });

  it("keeps keys for the service's address", async () => {
    const { backend, calls } = setup(() => Promise.resolve());
    await backend.saveKey(claude, "sk-1");
    await backend.saveKey(
      { id: "s2", kind: "compatible", baseUrl: "https://ai.example.org/v1/" },
      "k",
    );
    expect(calls.map((call) => call.args)).toEqual([
      {
        id: "s1",
        key: "sk-1",
        base: "https://api.anthropic.com/v1",
        header: "x-api-key",
      },
      {
        id: "s2",
        key: "k",
        base: "https://ai.example.org/v1",
        header: "bearer",
      },
    ]);
    await expect(
      backend.saveKey({ id: "s3", kind: "ollama" }, "k"),
    ).rejects.toThrow();
    expect(await backend.credentials()).toEqual({
      persistent: true,
      ids: new Set(["s1"]),
    });
  });

  it("signs in natively and tells refusals apart", async () => {
    const invoke = vi.fn((command: string) =>
      command === "ai_chatgpt_sign_in"
        ? Promise.resolve({ account: "max@example.org" })
        : // The native side refuses with `{kind, message}`.
          Promise.reject(
            Object.assign(new Error("Closed."), { kind: "cancelled" }),
          ),
    ) as unknown as Invoke;
    const backend = createNativeAiBackend(invoke, page, () => "channel");
    const chatgpt = { id: "s4", kind: "chatgpt" } as const;
    await expect(backend.signIn.chatgpt?.(chatgpt)).resolves.toEqual({
      account: "max@example.org",
    });
    expect(invoke).toHaveBeenCalledWith("ai_chatgpt_sign_in", {
      id: "s4",
      page: page(),
    });
    const error: unknown = await backend.signIn
      .openrouter({ id: "s5", kind: "openrouter" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthError);
    expect((error as NativeAuthError).kind).toBe("cancelled");
  });
});
