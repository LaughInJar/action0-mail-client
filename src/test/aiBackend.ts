/**
 * A fake AI backend for UI tests: it speaks Anthropic's protocol (models
 * and streamed messages) from memory and records what was asked.
 */
import { vi } from "vitest";
import type { AiBackend, AiHttpRequest } from "../ai/backend";
import type { AiServiceConfig } from "../ai/types";
import { sseResponse } from "./aiStreams";

/** A request to `/messages`, as sent. */
export interface AskedMessages {
  readonly service: string;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly { role: string; content: string }[];
}

/** Options of {@link fakeAiBackend}. */
export interface FakeAiOptions {
  /** The answer to a request (default: "An answer from the AI."). */
  readonly answer?: (asked: AskedMessages) => string;
  /** An error status (and Anthropic's error type) for every request. */
  readonly failure?: { readonly status: number; readonly type: string };
  /** Services that already have a key. */
  readonly keyed?: readonly string[];
  /** `vault`: like the apps (no Remember; ChatGPT sign-in). */
  readonly keeps?: "browser" | "vault";
}

/** See the module docs. */
export function fakeAiBackend(options: FakeAiOptions = {}) {
  const keys = new Map<string, string>(
    (options.keyed ?? []).map((id) => [id, "sk-test"]),
  );
  const asked: AskedMessages[] = [];
  const sent: AiHttpRequest[] = [];
  const answer = options.answer ?? (() => "An answer from the AI.");
  const vault = options.keeps === "vault";

  const send = (service: AiServiceConfig, request: AiHttpRequest) => {
    sent.push(request);
    const { failure } = options;
    if (failure)
      return Promise.resolve(
        Response.json(
          {
            type: "error",
            error: { type: failure.type, message: "Refused" },
          },
          { status: failure.status },
        ),
      );
    if (request.url.includes("/models"))
      return Promise.resolve(
        Response.json({
          data: [
            { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
            { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
          ],
        }),
      );
    const body = JSON.parse(request.body ?? "{}") as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
    };
    const question: AskedMessages = {
      service: service.id,
      model: body.model,
      system: body.system,
      messages: body.messages,
    };
    asked.push(question);
    const words = answer(question).split(/(?<=\s)/);
    return Promise.resolve(
      sseResponse([
        ...words.map((text) => ({
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        })),
        { type: "message_stop" },
      ]),
    );
  };

  const backend: AiBackend = {
    keeps: vault ? "vault" : "browser",
    credentials: () =>
      Promise.resolve({ ids: new Set(keys.keys()), persistent: true }),
    send: vi.fn(send),
    saveKey: vi.fn((service: AiServiceConfig, key: string) => {
      keys.set(service.id, key);
      return Promise.resolve();
    }),
    forget: vi.fn((service: AiServiceConfig) => {
      keys.delete(service.id);
      return Promise.resolve();
    }),
    ...(vault
      ? {}
      : {
          setRemember: vi.fn<NonNullable<AiBackend["setRemember"]>>(),
        }),
    signIn: {
      openrouter: vi.fn((service: AiServiceConfig) => {
        keys.set(service.id, "sk-or");
        return Promise.resolve();
      }),
      ...(vault
        ? {
            chatgpt: vi.fn((service: AiServiceConfig) => {
              keys.set(service.id, "chatgpt");
              return Promise.resolve({ account: "me@example.com" });
            }),
          }
        : {}),
    },
  };
  return { backend, keys, asked, sent };
}
