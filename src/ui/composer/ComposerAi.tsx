import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useAiServices } from "../../ai/context";
import { localTime, visibleText } from "../../ai/mailText";
import { writeRequest, type WriteInput } from "../../ai/prompts";
import type { EmailAddress } from "../../core/model";
import { useT } from "../../i18n/context";
import { useRouter } from "../../state/context";
import type { ComposerSession } from "../../state/uiStore";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { ChatGptNote } from "../ai/AiPanel";
import { AiPicker } from "../ai/AiPicker";
import { openAiSettings } from "../ai/aiSettingsLink";
import {
  aiErrorText,
  aiLanguage,
  askAi,
  needsSettings,
  useAiChoice,
  useAiNotice,
} from "../ai/useAi";
import {
  draftText,
  startWriting,
  writeTarget,
  type WriteTarget,
} from "./aiWriter";

/** Props of {@link ComposerAi}. */
export interface ComposerAiProps {
  readonly editor: Editor | null;
  readonly session: ComposerSession;
  /** Who the mail is from (the AI may sign with the name). */
  readonly from: EmailAddress | undefined;
  /** Bumped to put the cursor into the field again (Ctrl/⌘+J). */
  readonly focusSignal: number;
  readonly onClose: () => void;
}

type QuickChange = "shorter" | "formal" | "friendly" | "fix";
const QUICK: readonly QuickChange[] = ["shorter", "formal", "friendly", "fix"];

/**
 * The composer's AI field: an instruction, quick changes, and the service.
 * An empty draft is written, a selection rewritten, otherwise the whole
 * draft; the text goes straight into the editor as it's written, and the
 * whole change is one undo step. The signature and the quote are outside
 * the editor, so they're never touched.
 */
export function ComposerAi({
  editor,
  session,
  from,
  focusSignal,
  onClose,
}: ComposerAiProps) {
  const t = useT();
  const a = t.ai;
  const ai = useAiServices();
  const router = useRouter();
  const choice = useAiChoice("composer");
  const notice = useAiNotice();
  const { service, model } = choice;
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState<WriteTarget["mode"]>("write");
  const [status, setStatus] = useState<"idle" | "writing" | "done">("idle");
  const [error, setError] = useState<unknown>();
  const [lastInstruction, setLastInstruction] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const running = useRef<AbortController | null>(null);
  const writing = status === "writing";

  useEffect(() => {
    input.current?.focus();
  }, [focusSignal]);

  // What the field acts on follows the selection and the draft.
  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      if (!editor.isDestroyed && editor.isEditable)
        setTarget(writeTarget(editor).mode);
    };
    follow();
    editor.on("selectionUpdate", follow);
    editor.on("update", follow);
    return () => {
      editor.off("selectionUpdate", follow);
      editor.off("update", follow);
    };
  }, [editor]);

  // Typing on keeps the text: Try again and Undo are for the AI's change only.
  useEffect(() => {
    if (!editor || status !== "done") return;
    const kept = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (transaction.docChanged) setStatus("idle");
    };
    editor.on("transaction", kept);
    return () => {
      editor.off("transaction", kept);
    };
  }, [editor, status]);

  // Closing the composer stops the writing.
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const write = async (asked: string) => {
    if (!editor || !service || !model || running.current) return;
    if (!(await notice(service))) return;
    const where = writeTarget(editor);
    const kind =
      session.kind === "reply" || session.kind === "reply-all"
        ? "reply"
        : session.kind === "forward"
          ? "forward"
          : session.quote
            ? "reply"
            : "new";
    const input: WriteInput = {
      instruction: asked,
      mode: where.mode,
      draft: draftText(editor),
      ...(where.selection === undefined ? {} : { selection: where.selection }),
      ...(session.quote ? { original: visibleText(session.quote.html) } : {}),
      kind,
      ...(from ? { from } : {}),
      to: session.to,
      subject: session.subject,
      hasSignature: !!session.signature?.html,
      language: aiLanguage(t.locale),
      now: localTime(new Date()),
    };
    const controller = new AbortController();
    running.current = controller;
    setError(undefined);
    setStatus("writing");
    setLastInstruction(asked);
    const writing = startWriting(editor, where);
    let text = "";
    try {
      text = await askAi(
        ai,
        service,
        writeRequest(input, model.id),
        controller.signal,
        (sofar) => {
          text = sofar;
          writing.update(sofar);
        },
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      running.current = null;
    }
    // Stopped: what was written so far stays (and can be undone).
    if (text.trim()) {
      writing.finish(text);
      setStatus("done");
    } else {
      writing.cancel();
      setStatus("idle");
    }
  };

  const submit = () => {
    const asked = instruction.trim();
    if (writing || (target !== "write" && !asked)) return;
    void write(asked);
  };

  const undo = () => {
    editor?.chain().focus().undo().run();
    setStatus("idle");
  };

  const placeholder =
    target === "selection"
      ? a.placeholders.selection
      : target === "draft"
        ? a.placeholders.draft
        : session.kind === "new"
          ? a.placeholders.new
          : a.placeholders.reply;

  return (
    <div
      role="group"
      aria-label={a.field}
      className="shrink-0 space-y-2 border-b border-violet-200 bg-violet-50/60 px-3 py-2 dark:border-violet-900/70 dark:bg-violet-950/25"
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Icon
          name="sparkles"
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
        />
        <input
          ref={input}
          type="text"
          aria-label={a.field}
          placeholder={placeholder}
          value={instruction}
          disabled={writing}
          onChange={(event) => {
            setInstruction(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Only the field closes, not the composer.
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11"
        />
        {writing ? (
          <button
            type="button"
            onClick={() => {
              running.current?.abort();
            }}
            className="flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium dark:border-zinc-700 pointer-coarse:min-h-11"
          >
            <Icon name="stop" className="size-3.5" />
            {a.stop}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!service || (target !== "write" && !instruction.trim())}
            className="rounded-md bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 pointer-coarse:min-h-11"
          >
            {target === "write" ? a.write : a.rewrite}
          </button>
        )}
        <IconButton label={a.closeField} icon="x" onClick={onClose} />
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        {target !== "write" && !writing && (
          <div
            role="group"
            aria-label={a.quickActions}
            className="flex flex-wrap gap-1.5"
          >
            {QUICK.map((change) => (
              <button
                key={change}
                type="button"
                onClick={() => {
                  void write(a.quickInstructions[change]);
                }}
                className="rounded-full border border-violet-200 bg-white px-2.5 py-0.5 text-xs font-medium hover:bg-violet-100 dark:border-violet-900 dark:bg-zinc-900 dark:hover:bg-violet-900/40 pointer-coarse:min-h-11"
              >
                {a.quick[change]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setInstruction(a.quickInstructions.translate);
                input.current?.focus();
              }}
              className="rounded-full border border-violet-200 bg-white px-2.5 py-0.5 text-xs font-medium hover:bg-violet-100 dark:border-violet-900 dark:bg-zinc-900 dark:hover:bg-violet-900/40 pointer-coarse:min-h-11"
            >
              {a.quick.translate}
            </button>
          </div>
        )}
        <AiPicker choice={choice} />
        {status === "done" && (
          <>
            <button
              type="button"
              onClick={() => {
                undo();
                void write(lastInstruction);
              }}
              className="rounded-md px-2 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/40 pointer-coarse:min-h-11"
            >
              {a.tryAgain}
            </button>
            <button
              type="button"
              onClick={undo}
              className="rounded-md px-2 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/40 pointer-coarse:min-h-11"
            >
              {a.undo}
            </button>
          </>
        )}
        {writing && (
          <span className="animate-pulse text-xs text-zinc-500">
            {a.writing}
          </span>
        )}
        {service?.kind === "chatgpt" && <ChatGptNote />}
      </div>
      {error !== undefined && service && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {aiErrorText(error, service, t)}{" "}
          {needsSettings(error) && (
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
  );
}
