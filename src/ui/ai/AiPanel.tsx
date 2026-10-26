import { useEffect, useId, useRef, useState } from "react";
import { useAiServices } from "../../ai/context";
import { AI_KINDS, CHATGPT_USAGE_URL } from "../../ai/kinds";
import { localTime, MAIL_BUDGET, mailText } from "../../ai/mailText";
import { readerRequest } from "../../ai/prompts";
import type { Message } from "../../core/model";
import { useT } from "../../i18n/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import type { AiEntry, AiPanelState } from "../../state/uiStore";
import { copyText } from "../common/clipboard";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { AiPicker } from "./AiPicker";
import { openAiSettings } from "./aiSettingsLink";
import { AiText } from "./AiText";
import {
  aiErrorText,
  aiLanguage,
  askAi,
  needsSettings,
  useAiChoice,
  useAiNotice,
} from "./useAi";

/** Props of {@link AiPanel}. */
export interface AiPanelProps {
  /** What it belongs to (see `aiTarget`). */
  readonly target: string;
  /** The messages it reads, oldest first. */
  readonly messages: readonly Message[];
  /** Reply with AI (none when the mail can't be answered). */
  readonly onReply?: () => void;
}

/**
 * The reader's AI panel, while it's open for this message or conversation:
 * a summary and a short chat about the mail, as they're written.
 */
export function AiPanel({ target, messages, onReply }: AiPanelProps) {
  const panel = useUi((state) =>
    state.aiPanel?.target === target ? state.aiPanel : null,
  );
  if (!panel) return null;
  return (
    <OpenPanel
      panel={panel}
      messages={messages}
      {...(onReply ? { onReply } : {})}
    />
  );
}

function OpenPanel({
  panel,
  messages,
  onReply,
}: {
  readonly panel: AiPanelState;
  readonly messages: readonly Message[];
  readonly onReply?: () => void;
}) {
  const t = useT();
  const a = t.ai;
  const ai = useAiServices();
  const store = useUiStore();
  const router = useRouter();
  const choice = useAiChoice("reader");
  const notice = useAiNotice();
  const { service, model } = choice;
  const { target, entries } = panel;
  const [question, setQuestion] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const running = useRef<AbortController | null>(null);
  const handled = useRef(0);
  const titleId = useId();
  const writing = entries.some((entry) => entry.status === "writing");
  const thread = messages.length > 1;

  const update = (index: number, patch: Partial<AiEntry>) => {
    store
      .getState()
      .updateAiEntries(target, (current) =>
        current.map((entry, at) =>
          at === index ? { ...entry, ...patch } : entry,
        ),
      );
  };

  /** Asks the next question (`null`: the summary), after the chat so far. */
  const run = async (asked: string | null) => {
    if (!service || !model || running.current) return;
    if (!(await notice(service))) return;
    const chat =
      store
        .getState()
        .aiPanel?.entries.filter((entry) => entry.status === "done") ?? [];
    const mail = mailText(
      messages,
      AI_KINDS[service.kind].local ? MAIL_BUDGET.local : MAIL_BUDGET.online,
    );
    const request = readerRequest(
      mail,
      chat,
      asked,
      model.id,
      aiLanguage(t.locale),
      localTime(new Date()),
    );
    const controller = new AbortController();
    running.current = controller;
    let index = 0;
    store.getState().updateAiEntries(target, (current) => {
      // A failed or stopped answer is replaced by the new try.
      const kept = current.filter((entry) => entry.status === "done");
      index = kept.length;
      return [
        ...kept,
        {
          question: asked,
          answer: "",
          status: "writing",
          ...(mail.included < mail.total
            ? { read: { included: mail.included, total: mail.total } }
            : {}),
        },
      ];
    });
    try {
      await askAi(ai, service, request, controller.signal, (answer) => {
        update(index, { answer });
      });
      update(index, { status: "done" });
    } catch (error) {
      update(
        index,
        controller.signal.aborted
          ? { status: "stopped" }
          : { status: "error", error },
      );
    } finally {
      running.current = null;
    }
  };

  // Opened (again): summarize if there's no summary yet, or wait for a question.
  const ready = service !== undefined && model !== undefined;
  useEffect(() => {
    if (panel.nonce === handled.current) return;
    if (panel.start === "ask") {
      handled.current = panel.nonce;
      input.current?.focus();
      return;
    }
    if (!ready) return;
    handled.current = panel.nonce;
    if (!entries.some((entry) => entry.question === null)) void run(null);
    // Once per opening, when the model is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, panel.nonce, panel.start]);

  // Leaving the mail stops the answer being written.
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const last = entries.at(-1);
  const read = entries.find((entry) => entry.read)?.read;
  const retry = () => {
    if (!last) return;
    // The new answer takes the old one's place.
    store.getState().updateAiEntries(target, (current) => current.slice(0, -1));
    void run(last.question);
  };
  const ask = () => {
    const text = question.trim();
    if (!text || writing) return;
    setQuestion("");
    void run(text);
  };

  return (
    <section
      aria-labelledby={titleId}
      className="mx-4 my-3 rounded-lg border border-violet-200 bg-violet-50/60 sm:mx-6 dark:border-violet-900/70 dark:bg-violet-950/25"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-violet-200 py-1 pr-1 pl-3 dark:border-violet-900/70">
        <Icon
          name="sparkles"
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
        />
        {/* On phones the picker and buttons need the room. */}
        <h2
          id={titleId}
          className="sr-only text-sm font-semibold sm:not-sr-only"
        >
          {a.panel}
        </h2>
        <AiPicker choice={choice} />
        <div className="ml-auto flex items-center">
          {writing ? (
            <IconButton
              label={a.stop}
              icon="stop"
              onClick={() => {
                running.current?.abort();
              }}
            />
          ) : (
            last && (
              <IconButton label={a.tryAgain} icon="refresh" onClick={retry} />
            )
          )}
          {last?.answer && !writing && (
            <IconButton
              label={a.copy}
              icon="copy"
              onClick={() => {
                copyText(last.answer, store, t, a.copied);
              }}
            />
          )}
          <IconButton
            label={a.close}
            icon="x"
            onClick={() => {
              running.current?.abort();
              store.getState().closeAiPanel();
            }}
          />
        </div>
      </div>
      {entries.length > 0 && (
        <div
          aria-live="polite"
          aria-busy={writing}
          className="space-y-3 px-3 py-3 text-sm"
        >
          {entries.map((entry, index) => (
            <div key={index} className="space-y-1">
              {entry.question !== null && (
                <p className="font-medium text-zinc-700 dark:text-zinc-300">
                  <span className="sr-only">{a.you}: </span>
                  {entry.question}
                </p>
              )}
              {entry.answer && <AiText text={entry.answer} />}
              {entry.status === "writing" && !entry.answer && (
                <p className="animate-pulse text-zinc-500">{a.writing}</p>
              )}
              {entry.status === "stopped" && (
                <p className="text-xs text-zinc-500">{a.stopped}</p>
              )}
              {entry.status === "error" && service && (
                <p role="alert" className="text-red-700 dark:text-red-400">
                  {aiErrorText(entry.error, service, t)}{" "}
                  {needsSettings(entry.error) && (
                    <button
                      type="button"
                      onClick={() => {
                        openAiSettings(router);
                      }}
                      className="font-medium underline"
                    >
                      {a.openSettings}
                    </button>
                  )}
                </p>
              )}
            </div>
          ))}
          {read && (
            <p className="text-xs text-zinc-500">
              {a.partly(read.included, read.total)}
            </p>
          )}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
        className="flex items-center gap-2 border-t border-violet-200 px-3 py-2 dark:border-violet-900/70"
      >
        <input
          ref={input}
          type="text"
          aria-label={thread ? a.askPlaceholderThread : a.askPlaceholder}
          placeholder={thread ? a.askPlaceholderThread : a.askPlaceholder}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11"
        />
        <button
          type="submit"
          disabled={!question.trim() || writing || !service}
          className="rounded-md bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {a.askSend}
        </button>
      </form>
      {(onReply !== undefined || service?.kind === "chatgpt") && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-sm">
          {onReply && (
            <button
              type="button"
              onClick={onReply}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/40 pointer-coarse:min-h-11"
            >
              <Icon name="reply" className="size-4" />
              {a.replyWithAi}
            </button>
          )}
          {service?.kind === "chatgpt" && <ChatGptNote />}
        </div>
      )}
    </section>
  );
}

/** "Using ChatGPT plan · Manage usage", wherever ChatGPT is asked (OpenAI's rule). */
export function ChatGptNote() {
  const t = useT();
  return (
    <span className="ml-auto text-xs text-zinc-500">
      {t.ai.usingPlan} ·{" "}
      <a
        href={CHATGPT_USAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        {t.ai.manageUsage}
      </a>
    </span>
  );
}
