/**
 * What action0 knows about each kind of AI service: the protocol it
 * speaks, its address, how it's set up, where the key goes, and which of
 * its models to start with.
 */
import type { AiKind, AiServiceConfig } from "./types";

/**
 * The wire protocol: Anthropic's Messages API, OpenAI's Chat Completions
 * (which most services and local servers speak), OpenAI's Responses API
 * (ChatGPT sign-in), or the demo's canned answers.
 */
export type AiProtocol = "messages" | "chat" | "responses" | "demo";

/** How a service is set up. */
export type AiSetup = "key" | "signIn" | "url" | "none";

/** The header that carries the key. */
export type AiKeyHeader = "x-api-key" | "bearer";

/** See the module docs. */
export interface AiKindInfo {
  readonly protocol: AiProtocol;
  /** The API's address; for local and other servers the suggested one. */
  readonly baseUrl: string;
  readonly setup: AiSetup;
  /** Where the key goes (none for local servers). */
  readonly keyHeader?: AiKeyHeader;
  /** A brand name, shown as it is; the others come from the UI's texts. */
  readonly brand?: string;
  /** The models to start with, the first the service lists wins. */
  readonly defaultModels: readonly string[];
  /** The service's page about what it does with what it's sent. */
  readonly privacyUrl?: string;
  /** Where to get a key. */
  readonly keyUrl?: string;
  /** It runs on this computer: nothing leaves it, but it reads less at once. */
  readonly local?: boolean;
}

export const AI_KINDS: Readonly<Record<AiKind, AiKindInfo>> = {
  anthropic: {
    protocol: "messages",
    baseUrl: "https://api.anthropic.com/v1",
    setup: "key",
    keyHeader: "x-api-key",
    brand: "Claude",
    defaultModels: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    privacyUrl:
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  openai: {
    protocol: "chat",
    baseUrl: "https://api.openai.com/v1",
    setup: "key",
    keyHeader: "bearer",
    brand: "OpenAI",
    defaultModels: ["gpt-6.1-sol", "gpt-6-luna"],
    privacyUrl: "https://developers.openai.com/api/docs/guides/your-data",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    protocol: "chat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    setup: "key",
    keyHeader: "bearer",
    brand: "Gemini",
    defaultModels: ["gemini-3.8-flash", "gemini-3.6-flash"],
    privacyUrl: "https://ai.google.dev/gemini-api/terms",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    protocol: "chat",
    baseUrl: "https://openrouter.ai/api/v1",
    setup: "signIn",
    keyHeader: "bearer",
    brand: "OpenRouter",
    defaultModels: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"],
    privacyUrl: "https://openrouter.ai/docs/guides/privacy/data-collection",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  chatgpt: {
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    setup: "signIn",
    brand: "ChatGPT",
    defaultModels: ["gpt-6.1-sol"],
    privacyUrl: "https://openai.com/policies/sign-in-with-chatgpt-terms/",
  },
  ollama: {
    protocol: "chat",
    baseUrl: "http://localhost:11434/v1",
    setup: "url",
    brand: "Ollama",
    defaultModels: [],
    local: true,
  },
  lmstudio: {
    protocol: "chat",
    baseUrl: "http://localhost:1234/v1",
    setup: "url",
    brand: "LM Studio",
    defaultModels: [],
    local: true,
  },
  compatible: {
    protocol: "chat",
    baseUrl: "",
    setup: "url",
    keyHeader: "bearer",
    defaultModels: [],
  },
  demo: {
    protocol: "demo",
    baseUrl: "",
    setup: "none",
    defaultModels: [],
  },
};

/** Where ChatGPT shows how much of the plan an app used. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** The service's API address, without a trailing slash. */
export function serviceBaseUrl(service: AiServiceConfig): string {
  const base = service.baseUrl ?? AI_KINDS[service.kind].baseUrl;
  return base.replace(/\/+$/, "");
}

/**
 * The model to start with: the first preferred one the service lists, else
 * the first it lists.
 */
export function defaultModel(
  kind: AiKind,
  models: readonly { readonly id: string }[],
): string | undefined {
  const ids = new Set(models.map((model) => model.id));
  return (
    AI_KINDS[kind].defaultModels.find((id) => ids.has(id)) ?? models[0]?.id
  );
}
