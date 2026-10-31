import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState } from "react";
import { displayNameOf } from "../../core/contacts";
import {
  previewImport,
  runImport,
  type ImportExisting,
} from "../../data/contactImport";
import {
  parseListToken,
  targetBook,
  writableBooks,
  type ContactSourceState,
} from "../../data/contacts";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import type { ContactImportState } from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";
import {
  BUTTON,
  CHECK,
  CHECK_ROW,
  FIELD,
  HINT,
  PRIMARY,
} from "../common/formStyles";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { bookLabel } from "./format";
import { useContactActions } from "./useContactActions";

/** How many names the preview lists. */
const SHOWN = 8;

/**
 * The import preview: how many contacts the file has, into which address
 * book, what to do with ones that are already there, and what can't be
 * stored; then the import with a progress bar and Cancel, and an undo
 * toast for all of it.
 */
export function ImportDialog({
  file,
  states,
  onClose,
}: {
  file: ContactImportState;
  states: readonly ContactSourceState[];
  onClose: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const store = useUiStore();
  const queryClient = useQueryClient();
  const actions = useContactActions();
  const last = useUi((state) => state.settings.lastAddressBook);
  const books = useMemo(() => writableBooks(states), [states]);
  const [token, setToken] = useState(
    () => targetBook(books, parseListToken(file.list), last)?.token ?? "",
  );
  const [mode, setMode] = useState<ImportExisting>("skip");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const target = books.find((entry) => entry.token === token) ?? books[0];
  const snapshot = target
    ? states.find((state) => state.source.key === target.source.key)?.snapshot
    : undefined;
  const preview = useMemo(
    () =>
      target
        ? previewImport(target.source, snapshot, target.book.id, file.cards)
        : undefined,
    [target, snapshot, file.cards],
  );
  const existing = preview?.existing.filter(Boolean).length ?? 0;
  const count = file.cards.length;
  const names = file.cards
    .slice(0, SHOWN)
    .map((card) => card.displayName || displayNameOf(card.fields) || c.unnamed);
  /** Cancel: stops a running import (its toast still offers Undo), else closes. */
  const cancel = () => {
    if (abort.current) abort.current.abort();
    else onClose();
  };

  const start = async () => {
    if (!target || !preview || progress !== null) return;
    // The permission popup (Google) has to open within the click.
    if (!(await actions.ensureWritable(target.source))) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress(0);
    setError(null);
    store.getState().updateSettings({ lastAddressBook: target.token });
    try {
      const result = await runImport(queryClient, {
        source: target.source,
        book: target.book.id,
        cards: file.cards,
        existing: preview.existing,
        mode,
        onProgress: setProgress,
        signal: controller.signal,
      });
      const summary = c.imported(result.created, result.merged, result.skipped);
      store.getState().showToast({
        message:
          result.failed > 0
            ? `${summary}. ${c.importFailed(result.failed, errorMessage(result.error, t))}`
            : summary,
        tone: result.failed > 0 && result.created === 0 ? "error" : "info",
        revert: () => {
          result.undo().catch((cause: unknown) => {
            store.getState().showToast({
              message: `${t.actions.couldntUndo}: ${errorMessage(cause, t)}`,
              tone: "error",
            });
          });
        },
      });
      onClose();
    } catch (cause) {
      setProgress(null);
      setError(errorMessage(cause, t));
    } finally {
      abort.current = null;
    }
  };

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={cancel} size="lg">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
          {c.importTitle}
        </h2>
        <IconButton label={c.cancel} icon="x" onClick={cancel} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <p className="font-medium break-words">
          {c.importSummary(count, file.fileName)}
        </p>
        <p className="text-zinc-600 dark:text-zinc-300">
          {names.join(", ")}
          {count > SHOWN && ` ${c.andMore(count - SHOWN)}`}
        </p>
        {books.length === 0 ? (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {c.noWritableBook}
          </p>
        ) : (
          <div className="space-y-1">
            <label htmlFor={`${id}-book`} className="block font-medium">
              {c.importInto}
            </label>
            <select
              id={`${id}-book`}
              value={target?.token ?? ""}
              disabled={progress !== null}
              onChange={(event) => {
                setToken(event.target.value);
              }}
              className={FIELD}
            >
              {books.map((entry) => (
                <option key={entry.token} value={entry.token}>
                  {bookLabel(entry, books)}
                </option>
              ))}
            </select>
          </div>
        )}
        {existing > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1">{c.existing(existing)}</legend>
            {(
              [
                ["skip", c.existingSkip],
                ["merge", c.existingMerge],
                ["new", c.existingNew],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={CHECK_ROW}>
                <input
                  type="radio"
                  name={`${id}-existing`}
                  checked={mode === value}
                  disabled={progress !== null}
                  onChange={() => {
                    setMode(value);
                  }}
                  className={CHECK}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        )}
        {preview && preview.lossy > 0 && (
          <p className={HINT}>{c.lossy(preview.lossy)}</p>
        )}
        {progress !== null && (
          <div className="space-y-1" role="status">
            <progress
              max={count}
              value={progress}
              className="h-2 w-full accent-blue-600"
            />
            <p className={HINT}>{c.importing(progress, count)}</p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        {error && (
          <p
            role="alert"
            className="mr-auto min-w-0 text-sm text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <button type="button" onClick={cancel} className={BUTTON}>
          {c.cancel}
        </button>
        <button
          type="button"
          disabled={!target || progress !== null}
          onClick={() => {
            void start();
          }}
          className={PRIMARY}
        >
          {c.importButton(count)}
        </button>
      </div>
    </Sheet>
  );
}
