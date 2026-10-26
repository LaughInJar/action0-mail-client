// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { collect, NamedEvent, sseResponse } from "../../test/aiStreams";
import type { AiBackend, AiHttpRequest } from "../backend";
import { createAiClient } from "../client";
import { AiError, type AiRequest, type AiServiceConfig } from "../types";
import { errorDetails, errorKind } from "./common";

const request: AiRequest = {
  task: "summary",
  model: "the-model",
  instructions: "Be brief.",
  turns: [
    { role: "user", text: "Hi" },
    { role: "assistant", text: "Hello" },
    { role: "user", text: "Summarize" },
  ],
};

/** A backend whose `send` answers with `answer` and records the requests. */
function backend(answer: (request: AiHttpRequest) => Response) {
  const sent: AiHttpRequest[] = [];
  const send = vi.fn((_service: AiServiceConfig, request: AiHttpRequest) => {
    sent.push(request);
    return Promise.resolve(answer(request));
  });
  const fake: AiBackend = {
    keeps: "browser",
    credentials: () => Promise.resolve({ ids: new Set(), persistent: true }),
    send,
    saveKey: () => Promise.resolve(),
    forget: () => Promise.resolve(),
    signIn: { openrouter: () => Promise.resolve() },
  };
  return { fake, sent };
}

const service = (kind: AiServiceConfig["kind"], baseUrl?: string) => ({
  id: "s1",
  kind,
  ...(baseUrl ? { baseUrl } : {}),
});

const write = (client: ReturnType<typeof createAiClient>) =>
  collect(client.write(request, new AbortController().signal));

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as AiError,
  );

describe("Anthropic's Messages API", () => {
  it("sends the system text and turns, and streams the text deltas", async () => {
    const { fake, sent } = backend(() =>
      sseResponse(
        [
          new NamedEvent("message_start", { type: "message_start" }),
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Short " },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "answer." },
          },
          { type: "message_stop" },
        ],
        { split: true },
      ),
    );
    expect(await write(createAiClient(service("anthropic"), fake))).toBe(
      "Short answer.",
    );
    const [sentRequest] = sent;
    expect(sentRequest?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sentRequest?.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(JSON.parse(sentRequest?.body ?? "")).toEqual({
      model: "the-model",
      max_tokens: 4096,
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Summarize" },
      ],
      stream: true,
    });
  });

  it("lists models by their display names", async () => {
    const { fake, sent } = backend(() =>
      Response.json({
        data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }],
      }),
    );
    expect(await createAiClient(service("anthropic"), fake).models()).toEqual([
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    ]);
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
  });

  it("turns a refused key and an error mid-answer into AiErrors", async () => {
    const refused = backend(() =>
      Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        { status: 401 },
      ),
    );
    const error = await failure(
      write(createAiClient(service("anthropic"), refused.fake)),
    );
    expect(error).toBeInstanceOf(AiError);
    expect(error.kind).toBe("key");
    expect(error.message).toBe("invalid x-api-key");

    const overloaded = backend(() =>
      sseResponse([
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Par" },
        },
        {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        },
      ]),
    );
    expect(
      (
        await failure(
          write(createAiClient(service("anthropic"), overloaded.fake)),
        )
      ).kind,
    ).toBe("unavailable");
  });
});

describe("Chat Completions", () => {
  it("puts the system text first and streams content deltas until [DONE]", async () => {
    const { fake, sent } = backend(() =>
      sseResponse(
        [
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          "[DONE]",
          { choices: [{ delta: { content: "ignored" } }] },
        ],
        { split: true },
      ),
    );
    expect(
      await write(
        createAiClient(service("ollama", "http://localhost:11434/v1/"), fake),
      ),
    ).toBe("Hello");
    expect(sent[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      model: "the-model",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Summarize" },
      ],
      stream: true,
    });
  });

  it("offers OpenAI's chat models newest first, Gemini's without the prefix, OpenRouter's by name", async () => {
    const openai = backend(() =>
      Response.json({
        data: [
          { id: "gpt-6-luna", created: 2 },
          { id: "text-embedding-4", created: 9 },
          { id: "gpt-6.1-sol", created: 3 },
          { id: "gpt-6-realtime", created: 4 },
          { id: "o5-mini", created: 1 },
        ],
      }),
    );
    expect(
      (await createAiClient(service("openai"), openai.fake).models()).map(
        (model) => model.id,
      ),
    ).toEqual(["gpt-6.1-sol", "gpt-6-luna", "o5-mini"]);

    const gemini = backend(() =>
      Response.json({
        data: [
          { id: "models/gemini-3.8-flash" },
          { id: "models/gemini-embedding-2" },
        ],
      }),
    );
    expect(
      await createAiClient(service("gemini"), gemini.fake).models(),
    ).toEqual([{ id: "gemini-3.8-flash", name: "gemini-3.8-flash" }]);
    expect(gemini.sent[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    );

    const openrouter = backend(() =>
      Response.json({
        data: [
          {
            id: "anthropic/claude-sonnet-5.5",
            name: "Anthropic: Claude Sonnet 5.5",
          },
        ],
      }),
    );
    expect(
      await createAiClient(service("openrouter"), openrouter.fake).models(),
    ).toEqual([
      {
        id: "anthropic/claude-sonnet-5.5",
        name: "Anthropic: Claude Sonnet 5.5",
      },
    ]);
  });

  it("tells no credit, limits, unknown models and no answer apart", async () => {
    const answer = (status: number, body: unknown) =>
      failure(
        write(
          createAiClient(
            service("openai"),
            backend(() => Response.json(body, { status })).fake,
          ),
        ),
      ).then((error) => error.kind);
    expect(
      await answer(429, {
        error: {
          message: "You exceeded your quota",
          code: "insufficient_quota",
        },
      }),
    ).toBe("credit");
    expect(await answer(429, { error: { message: "Slow down" } })).toBe(
      "limit",
    );
    expect(await answer(404, { error: "model 'x' not found" })).toBe("model");
    expect(
      await answer(402, { error: { message: "Insufficient credits" } }),
    ).toBe("credit");
    expect(await answer(503, {})).toBe("unavailable");

    const offline: AiBackend = {
      ...backend(() => new Response()).fake,
      send: () => Promise.reject(new TypeError("Failed to fetch")),
    };
    expect(
      (await failure(write(createAiClient(service("lmstudio"), offline)))).kind,
    ).toBe("unreachable");
  });
});

describe("Responses API (ChatGPT)", () => {
  it("sends instructions without a system turn, stores nothing, and waits for completed", async () => {
    const { fake, sent } = backend(() =>
      sseResponse([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: "Plan " },
        { type: "response.output_text.delta", delta: "text" },
        { type: "response.completed" },
      ]),
    );
    expect(await write(createAiClient(service("chatgpt"), fake))).toBe(
      "Plan text",
    );
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      model: "the-model",
      instructions: "Be brief.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hi" }] },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
        { role: "user", content: [{ type: "input_text", text: "Summarize" }] },
      ],
      store: false,
      stream: true,
    });
  });

  it("lists the models ChatGPT offers for listing", async () => {
    const { fake } = backend(() =>
      Response.json({
        models: [
          {
            slug: "gpt-6.1-sol",
            display_name: "GPT-6.1 Sol",
            visibility: "list",
          },
          { slug: "internal", visibility: "hide" },
        ],
      }),
    );
    expect(await createAiClient(service("chatgpt"), fake).models()).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    ]);
  });

  it("says when the plan's limit is reached, the sign-in ran out, or the answer broke off", async () => {
    const limit = backend(() =>
      Response.json(
        {
          error: {
            code: "subscription_sharing_usage_limit_exceeded",
            message: "Usage limit reached",
          },
        },
        { status: 429 },
      ),
    );
    expect(
      (await failure(write(createAiClient(service("chatgpt"), limit.fake))))
        .kind,
    ).toBe("limit");

    const expired = backend(() => Response.json({}, { status: 401 }));
    expect(
      (await failure(write(createAiClient(service("chatgpt"), expired.fake))))
        .kind,
    ).toBe("signIn");

    const midway = backend(() =>
      sseResponse([
        { type: "response.output_text.delta", delta: "Half" },
        {
          type: "error",
          code: "subscription_sharing_usage_unavailable",
          message: "Try later",
        },
      ]),
    );
    expect(
      (await failure(write(createAiClient(service("chatgpt"), midway.fake))))
        .kind,
    ).toBe("unavailable");

    const brokenOff = backend(() =>
      sseResponse([{ type: "response.output_text.delta", delta: "Half" }]),
    );
    expect(
      (await failure(write(createAiClient(service("chatgpt"), brokenOff.fake))))
        .kind,
    ).toBe("unavailable");
  });
});

describe("error answers", () => {
  it("reads the shapes services use", () => {
    expect(
      errorDetails([
        { error: { message: "Bad key", status: "INVALID_ARGUMENT" } },
      ]),
    ).toEqual({
      message: "Bad key",
      code: "INVALID_ARGUMENT",
    });
    expect(errorDetails({ error: "no model" })).toEqual({
      message: "no model",
      code: "",
    });
    expect(
      errorKind(400, {
        message: "Your credit balance is too low to access the Anthropic API.",
        code: "invalid_request_error",
      }),
    ).toBe("credit");
  });
});

describe("the demo", () => {
  it("writes its canned answer word by word, and stops when asked", async () => {
    const { fake } = backend(() => new Response());
    const client = createAiClient(service("demo"), fake);
    expect(await client.models()).toEqual([{ id: "demo", name: "Demo" }]);
    const stop = new AbortController();
    const pieces: string[] = [];
    await expect(
      (async () => {
        for await (const piece of client.write(request, stop.signal)) {
          pieces.push(piece);
          if (pieces.length === 2) stop.abort();
        }
      })(),
    ).rejects.toBeDefined();
    expect(pieces.join("")).toBe("The sender ");
  });
});
