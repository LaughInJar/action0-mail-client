/** A set-up service as an {@link AiClient}: its protocol over the backend. */
import type { AiBackend } from "./backend";
import { demoClient } from "./demo";
import { AI_KINDS, type AiProtocol } from "./kinds";
import { chatProtocol } from "./protocols/chat";
import type { Protocol } from "./protocols/common";
import { messagesProtocol } from "./protocols/messages";
import { responsesProtocol } from "./protocols/responses";
import type { AiClient, AiServiceConfig } from "./types";

const PROTOCOLS: Readonly<Record<Exclude<AiProtocol, "demo">, Protocol>> = {
  messages: messagesProtocol,
  chat: chatProtocol,
  responses: responsesProtocol,
};

/** See the module docs. */
export function createAiClient(
  service: AiServiceConfig,
  backend: AiBackend,
): AiClient {
  const kind = AI_KINDS[service.kind];
  if (kind.protocol === "demo") return demoClient;
  const protocol = PROTOCOLS[kind.protocol];
  const send = (
    request: Parameters<AiBackend["send"]>[1],
    signal?: AbortSignal,
  ) => backend.send(service, request, signal);
  return {
    models: (signal) => protocol.models(send, service, signal),
    write: (request, signal) => protocol.write(send, service, request, signal),
  };
}
