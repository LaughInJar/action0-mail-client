import { useId, useRef } from "react";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import type { QuestionState } from "../../state/eventForm";
import { useFocusTrap } from "./useFocusTrap";

/** Shows the dialog while a question waits for its answer. */
export function QuestionHost() {
  const question = useUi((state) => state.question);
  if (!question) return null;
  return <QuestionDialog question={question} />;
}

/**
 * A question with one button per answer. Cancel comes first and has focus,
 * so Enter or Escape never does anything by accident.
 */
function QuestionDialog({ question }: { question: QuestionState }) {
  const store = useUiStore();
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const answer = (value: string | null) => {
    store.getState().setQuestion(null);
    question.resolve(value);
  };
  useFocusTrap(dialogRef, true, () => {
    answer(null);
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t.common.dismiss}
        onClick={() => {
          answer(null);
        }}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(question.message ? { "aria-describedby": messageId } : {})}
        className="relative w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {question.title}
        </h2>
        {question.message && (
          <p
            id={messageId}
            className="mt-2 text-sm text-zinc-600 dark:text-zinc-400"
          >
            {question.message}
          </p>
        )}
        <div
          className={`mt-5 flex flex-col-reverse gap-2 ${question.options.length > 2 ? "" : "sm:flex-row sm:justify-end"}`}
        >
          <button
            type="button"
            onClick={() => {
              answer(null);
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {question.cancelLabel ?? t.common.cancel}
          </button>
          {/* Reversed: the first option ends up on top (or rightmost). */}
          {[...question.options].reverse().map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                answer(option.value);
              }}
              className={`rounded-md px-3 py-1.5 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none pointer-coarse:min-h-11 ${
                option.tone === "danger"
                  ? "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500"
                  : option.tone === "primary"
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              }`}
            >
              {option.label}
              {option.description && (
                <span className="block text-xs font-normal opacity-90">
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
