/** Anthropic's Messages API (Claude). */
import { serviceBaseUrl } from "../kinds";
import { sseEvents } from "../sse";
import {
  call,
  isRecord,
  json,
  parseEvent,
  streamError,
  streamOf,
  type Protocol,
} from "./common";

/**
 * The API version, and Anthropic's consent to calls straight from a
 * browser (the web app has no server to make them).
 */
const HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

/** Enough for a long mail; the services need a limit. */
const MAX_TOKENS = 4096;

export const messagesProtocol: Protocol = {
  models: async (send, service, signal) => {
    const response = await call(
      send,
      {
        url: `${serviceBaseUrl(service)}/models?limit=1000`,
        method: "GET",
        headers: HEADERS,
      },
      signal,
    );
    const body = await json(response);
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return data.filter(isRecord).flatMap((model) =>
      typeof model.id === "string"
        ? [
            {
              id: model.id,
              name:
                typeof model.display_name === "string"
                  ? model.display_name
                  : model.id,
            },
          ]
        : [],
    );
  },

  async *write(send, service, request, signal) {
    const response = await call(
      send,
      {
        url: `${serviceBaseUrl(service)}/messages`,
        method: "POST",
        headers: { ...HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          max_tokens: MAX_TOKENS,
          system: request.instructions,
          messages: request.turns.map((turn) => ({
            role: turn.role,
            content: turn.text,
          })),
          stream: true,
        }),
      },
      signal,
    );
    for await (const event of sseEvents(streamOf(response))) {
      const data = parseEvent(event.data);
      if (!isRecord(data)) continue;
      if (data.type === "error") throw streamError(data);
      if (data.type === "message_stop") return;
      const delta = data.delta;
      if (
        data.type === "content_block_delta" &&
        isRecord(delta) &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      )
        yield delta.text;
    }
  },
};
