/**
 * What the AI panel, the composer's AI field and Settings share: the set-up
 * services and their names, their models, the service and model chosen in
 * each place, asking, the note before a service's first use, and errors in
 * words.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAiServices } from "../../ai/context";
import { AI_KINDS, CHATGPT_USAGE_URL, defaultModel } from "../../ai/kinds";
import type { AiServices } from "../../ai/services";
import {
  AiError,
  type AiChoice,
  type AiModel,
  type AiRequest,
  type AiServiceConfig,
} from "../../ai/types";
import type { AccountId, MessageId, ThreadId } from "../../core/ids";
import { useT, type I18n } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import { MAX_AI_RECENT, type AiPlace } from "../../state/settings";
import { useAsk } from "../common/useAsk";

/** A service's name: its brand, the user's name for it, or the kind's. */
export function serviceLabel(service: AiServiceConfig, t: I18n): string {
  const names = t.ai.settings.kindNames;
  return (
    AI_KINDS[service.kind].brand ??
    (service.kind === "compatible"
      ? service.name || names.compatible
      : names.demo)
  );
}

/** The interface's language in English ("German"): the AI answers in it. */
export function aiLanguage(locale: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

/** What the AI panel belongs to: a message, or a whole conversation. */
export const aiTarget = {
  message: (accountId: AccountId, messageId: MessageId) =>
    JSON.stringify(["message", accountId, messageId]),
  thread: (accountId: AccountId, threadId: ThreadId) =>
    JSON.stringify(["thread", accountId, threadId]),
};

/** The services set up; the AI buttons show only when there's one. */
export function useAiSetUp(): readonly AiServiceConfig[] {
  return useUi((state) => state.settings.aiServices);
}

/** Query key of a service's models (dropped when it's set up anew). */
export const aiModelsKey = (service: AiServiceConfig) =>
  ["ai", service.id, "models", service.baseUrl ?? ""] as const;

/** The models a service offers, loaded when needed and kept for an hour. */
export function useAiModels(service: AiServiceConfig | undefined) {
  const ai = useAiServices();
  return useQuery({
    queryKey: service ? aiModelsKey(service) : ["ai", "none"],
    queryFn: ({ signal }) =>
      service ? ai.client(service).models(signal) : Promise.resolve([]),
    enabled: service !== undefined,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** The service and model a place uses, and choosing another. */
export interface AiChoiceState {
  readonly service: AiServiceConfig | undefined;
  /** Unknown until the service's models are loaded, if none was chosen yet. */
  readonly model: AiModel | undefined;
  readonly choose: (choice: AiChoice) => void;
}

/**
 * The reader's or the composer's choice: the one used there last, else the
 * first service with its preferred model.
 */
export function useAiChoice(place: AiPlace): AiChoiceState {
  const services = useAiSetUp();
  const saved = useUi((state) => state.settings.aiChoices[place]);
  const store = useUiStore();
  const service =
    services.find((candidate) => candidate.id === saved?.service) ??
    services[0];
  const { data: models } = useAiModels(service);
  const savedModel =
    saved && saved.service === service?.id ? saved.model : undefined;
  const modelId =
    savedModel ??
    (service && models ? defaultModel(service.kind, models) : undefined);
  const model = useMemo(
    () =>
      modelId === undefined
        ? undefined
        : (models?.find((candidate) => candidate.id === modelId) ?? {
            id: modelId,
            name: modelId,
          }),
    [modelId, models],
  );
  const choose = useCallback(
    (choice: AiChoice) => {
      const { settings, updateSettings } = store.getState();
      updateSettings({
        aiChoices: { ...settings.aiChoices, [place]: choice },
        aiRecent: [
          choice,
          ...settings.aiRecent.filter(
            (recent) =>
              recent.service !== choice.service ||
              recent.model !== choice.model,
          ),
        ].slice(0, MAX_AI_RECENT),
      });
    },
    [store, place],
  );
  return useMemo(() => ({ service, model, choose }), [service, model, choose]);
}

/**
 * Asks a service; `onText` gets the answer so far as it's written.
 * Resolves to the whole answer. A service that needs a key or sign-in it
 * doesn't have fails with `noKey` before anything is sent.
 */
export async function askAi(
  ai: AiServices,
  service: AiServiceConfig,
  request: AiRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  const { setup } = AI_KINDS[service.kind];
  if (setup === "key" || setup === "signIn") {
    const { ids } = await ai.backend.credentials();
    if (!ids.has(service.id)) throw new AiError("noKey", "");
  }
  let text = "";
  for await (const piece of ai.client(service).write(request, signal)) {
    text += piece;
    onText(text);
  }
  return text;
}

/** Why a request failed, in words. */
export function aiErrorText(
  error: unknown,
  service: AiServiceConfig,
  t: I18n,
): string {
  const e = t.ai.errors;
  const label = serviceLabel(service, t);
  const signsIn = AI_KINDS[service.kind].setup === "signIn";
  if (!(error instanceof AiError))
    return e.other(label, error instanceof Error ? error.message : "");
  switch (error.kind) {
    case "noKey":
      return service.kind === "chatgpt" ? e.signIn(label) : e.keyMissing(label);
    case "key":
      return signsIn && service.kind === "chatgpt"
        ? e.signIn(label)
        : e.key(label);
    case "signIn":
      return e.signIn(label);
    case "credit":
      return e.credit(label);
    case "limit":
      return service.kind === "chatgpt" ? e.planLimit : e.limit(label);
    case "notEligible":
      return e.notEligible;
    case "unavailable":
      return e.unavailable(label);
    case "unreachable":
      return AI_KINDS[service.kind].local || service.kind === "compatible"
        ? e.unreachableLocal(label)
        : e.unreachable(label);
    case "model":
      return e.model;
    case "other":
      return e.other(label, error.message);
  }
}

/** The error is fixed in Settings (a key, a sign-in), not by trying again. */
export function needsSettings(error: unknown): boolean {
  return (
    error instanceof AiError &&
    (error.kind === "noKey" || error.kind === "key" || error.kind === "signIn")
  );
}

/**
 * The note before a service's first use: what it gets and where its data
 * policy is (ChatGPT: OpenAI's "You're using your ChatGPT plan"). Resolves
 * to true once the user went on, at once if they did before.
 */
export function useAiNotice(): (service: AiServiceConfig) => Promise<boolean> {
  const ask = useAsk();
  const store = useUiStore();
  const t = useT();
  return useCallback(
    async (service) => {
      if (
        service.kind === "demo" ||
        store.getState().settings.aiNoticed.includes(service.id)
      )
        return true;
      const n = t.ai.notice;
      const label = serviceLabel(service, t);
      const kind = AI_KINDS[service.kind];
      const chatgpt = service.kind === "chatgpt";
      const link = chatgpt
        ? { label: t.ai.manageUsage, href: CHATGPT_USAGE_URL }
        : kind.privacyUrl
          ? { label: n.policy(label), href: kind.privacyUrl }
          : undefined;
      const answer = await ask({
        title: chatgpt ? n.chatgptTitle : n.title(label),
        message: chatgpt
          ? n.chatgptMessage
          : kind.local
            ? n.local(label)
            : n.message(label),
        ...(link ? { link } : {}),
        options: [{ value: "continue", label: n.continue, tone: "primary" }],
      });
      if (answer !== "continue") return false;
      const { settings, updateSettings } = store.getState();
      updateSettings({ aiNoticed: [...settings.aiNoticed, service.id] });
      return true;
    },
    [ask, store, t],
  );
}
