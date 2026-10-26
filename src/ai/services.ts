/** The AI assistant as the app gets it: the backend, and clients over it. */
import type { AiBackend } from "./backend";
import { createAiClient } from "./client";
import type { AiClient, AiServiceConfig } from "./types";

export interface AiServices {
  /** Where keys live and how requests go out (browser or vault). */
  readonly backend: AiBackend;
  /** A set-up service, ready to ask. */
  readonly client: (service: AiServiceConfig) => AiClient;
}

/** See {@link AiServices}. */
export function createAiServices(backend: AiBackend): AiServices {
  return {
    backend,
    client: (service) => createAiClient(service, backend),
  };
}
