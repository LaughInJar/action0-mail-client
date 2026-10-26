/**
 * The AI assistant's contracts: the services the user sets up, the models
 * they offer, and a client that writes an answer as it's generated. The UI
 * knows only these; the protocols (`protocols/`) and where keys live
 * (`backend.ts`) stay behind them.
 */

/** The kinds of AI service action0 talks to. */
export type AiKind =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openrouter"
  | "chatgpt"
  | "ollama"
  | "lmstudio"
  | "compatible"
  | "demo";

/** A service the user set up: a setting, never its key. */
export interface AiServiceConfig {
  /** Random and stable; keys and sign-ins are kept under it. */
  readonly id: string;
  readonly kind: AiKind;
  /** Another OpenAI-compatible server: the user's name for it. */
  readonly name?: string;
  /** Local and other servers: the API's address (ending in `/v1`). */
  readonly baseUrl?: string;
  /** The web app keeps the key in localStorage instead of sessionStorage. */
  readonly remember?: boolean;
  /** ChatGPT: who signed in (shown only). */
  readonly account?: string;
}

/** A model a service offers. */
export interface AiModel {
  readonly id: string;
  /** What the picker shows. */
  readonly name: string;
}

/** A service and one of its models. */
export interface AiChoice {
  readonly service: string;
  readonly model: string;
}

/** A turn of the conversation with the AI. */
export interface AiTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** What a request is for. */
export type AiTask = "summary" | "ask" | "write" | "rewrite";

/** What the AI is asked. */
export interface AiRequest {
  /** What it's for (the demo answers by it; services never see it). */
  readonly task: AiTask;
  readonly model: string;
  /** The system text: the task and its rules. */
  readonly instructions: string;
  /** The conversation so far, ending with the user's turn. */
  readonly turns: readonly AiTurn[];
}

/** One set-up service, ready to ask. */
export interface AiClient {
  /** The models it offers (the service's own list). */
  readonly models: (signal?: AbortSignal) => Promise<readonly AiModel[]>;
  /** The answer's text, piece by piece as it's written. Throws {@link AiError}. */
  readonly write: (
    request: AiRequest,
    signal: AbortSignal,
  ) => AsyncIterable<string>;
}

/**
 * Why a request failed, as the UI tells it apart:
 * - `noKey`: no key or sign-in is known for the service (the web app
 *   forgets keys with the browser session unless asked to remember them).
 * - `key`: the key was refused.
 * - `signIn`: the sign-in ran out or was revoked; sign in again.
 * - `credit`: the account has no credit left.
 * - `limit`: too many requests, or the plan's usage limit is reached.
 * - `notEligible`: the ChatGPT plan can't be used for this.
 * - `unavailable`: the service is overloaded or down; try later.
 * - `unreachable`: no answer at all (offline, a local server not running,
 *   or the browser blocked it).
 * - `model`: the model doesn't exist (any more).
 * - `other`: anything else; the message is the service's own.
 */
export type AiErrorKind =
  | "noKey"
  | "key"
  | "signIn"
  | "credit"
  | "limit"
  | "notEligible"
  | "unavailable"
  | "unreachable"
  | "model"
  | "other";

/** A failed AI request. `message` is the service's own text, if it gave one. */
export class AiError extends Error {
  override readonly name = "AiError";
  readonly kind: AiErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: AiErrorKind,
    message: string,
    options?: { readonly status?: number; readonly cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.kind = kind;
    this.status = options?.status;
  }
}
