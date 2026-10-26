/**
 * OpenAI's Responses API as Sign in with ChatGPT allows it: nothing stored
 * (`store: false`), always streamed, the system text as `instructions`, and
 * none of the options it refuses (temperature, token limits, metadata).
 * An answer only counts once `response.completed` arrives.
 */
import { serviceBaseUrl } from "../kinds";
import { sseEvents } from "../sse";
import { AiError } from "../types";
import {
  call,
  isRecord,
  json,
  parseEvent,
  streamError,
  streamOf,
  type Protocol,
} from "./common";

const SIGN_IN = { signIn: true } as const;

export const responsesProtocol: Protocol = {
  models: async (send, service, signal) => {
    const response = await call(
      send,
      { url: `${serviceBaseUrl(service)}/models`, method: "GET", headers: {} },
      signal,
      SIGN_IN,
    );
    const body = await json(response);
    // `{models: [{slug, display_name, visibility}]}`; only "list" ones are offered.
    const models =
      isRecord(body) && Array.isArray(body.models) ? body.models : [];
    return models.filter(isRecord).flatMap((model) =>
      typeof model.slug === "string" &&
      (model.visibility === undefined || model.visibility === "list")
        ? [
            {
              id: model.slug,
              name:
                typeof model.display_name === "string"
                  ? model.display_name
                  : model.slug,
            },
          ]
        : [],
    );
  },

  async *write(send, service, request, signal) {
    const response = await call(
      send,
      {
        url: `${serviceBaseUrl(service)}/responses`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          instructions: request.instructions,
          input: request.turns.map((turn) => ({
            role: turn.role,
            content: [
              {
                type: turn.role === "user" ? "input_text" : "output_text",
                text: turn.text,
              },
            ],
          })),
          store: false,
          stream: true,
        }),
      },
      signal,
      SIGN_IN,
    );
    for await (const event of sseEvents(streamOf(response))) {
      const data = parseEvent(event.data);
      if (!isRecord(data)) continue;
      switch (data.type) {
        case "response.output_text.delta":
          if (typeof data.delta === "string") yield data.delta;
          break;
        case "response.completed":
        case "response.incomplete":
          return;
        case "response.failed":
          throw streamError(
            isRecord(data.response) ? data.response : data,
            SIGN_IN,
          );
        case "error":
          throw streamError(data, SIGN_IN);
      }
    }
    throw new AiError("unavailable", "The answer broke off.");
  },
};
