/**
 * OpenAI's Chat Completions API, which OpenAI, Gemini (its OpenAI-compatible
 * endpoint), OpenRouter, Ollama, LM Studio and most other servers speak.
 */
import { serviceBaseUrl } from "../kinds";
import { sseEvents } from "../sse";
import type { AiKind, AiModel } from "../types";
import {
  call,
  isRecord,
  json,
  parseEvent,
  streamError,
  streamOf,
  type Protocol,
} from "./common";

/** OpenAI's models that don't write text (or not through this API). */
const OPENAI_NOT_CHAT =
  /audio|realtime|tts|transcribe|whisper|dall-e|image|embedding|moderation|search|instruct|babbage|davinci|computer/;
/** Gemini's models that don't write text. */
const GEMINI_NOT_CHAT = /embedding|imagen|veo|aqa|tts|image|audio|live/;

/** The models worth offering, named as the service names them. */
export function chatModels(kind: AiKind, data: readonly unknown[]): AiModel[] {
  const models = data.filter(isRecord).flatMap((model) => {
    if (typeof model.id !== "string") return [];
    // Gemini lists "models/gemini-…" but takes the name without the prefix.
    const id = model.id.replace(/^models\//, "");
    const name =
      typeof model.name === "string" && kind === "openrouter"
        ? model.name
        : typeof model.display_name === "string"
          ? model.display_name
          : id;
    const created = typeof model.created === "number" ? model.created : 0;
    return [{ id, name, created }];
  });
  const offered =
    kind === "openai"
      ? models
          .filter(
            ({ id }) =>
              /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_NOT_CHAT.test(id),
          )
          // Newest first; OpenAI lists them in no useful order.
          .sort((a, b) => b.created - a.created)
      : kind === "gemini"
        ? models.filter(
            ({ id }) => id.startsWith("gemini") && !GEMINI_NOT_CHAT.test(id),
          )
        : models;
  return offered.map(({ id, name }) => ({ id, name }));
}

export const chatProtocol: Protocol = {
  models: async (send, service, signal) => {
    const response = await call(
      send,
      { url: `${serviceBaseUrl(service)}/models`, method: "GET", headers: {} },
      signal,
    );
    const body = await json(response);
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return chatModels(service.kind, data);
  },

  async *write(send, service, request, signal) {
    const response = await call(
      send,
      {
        url: `${serviceBaseUrl(service)}/chat/completions`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.instructions },
            ...request.turns.map((turn) => ({
              role: turn.role,
              content: turn.text,
            })),
          ],
          stream: true,
        }),
      },
      signal,
    );
    for await (const event of sseEvents(streamOf(response))) {
      if (event.data === "[DONE]") return;
      const data = parseEvent(event.data);
      if (!isRecord(data)) continue;
      if (data.error !== undefined) throw streamError(data);
      const choice: unknown = Array.isArray(data.choices)
        ? data.choices[0]
        : undefined;
      const delta = isRecord(choice) ? choice.delta : undefined;
      if (isRecord(delta) && typeof delta.content === "string" && delta.content)
        yield delta.content;
    }
  },
};
