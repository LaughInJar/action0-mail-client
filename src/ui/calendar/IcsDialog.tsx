import { useId, useRef, useState, type SubmitEvent } from "react";
import type { IcsSubscription } from "../../core/calendar";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { Sheet } from "../common/Sheet";
import { colorName } from "../labels/colorName";
import { SUBSCRIPTION_COLORS, useSubscriptions } from "./useSubscriptions";

/**
 * Adds a calendar by its iCal address, or changes one: the address is
 * checked (read once) before it's saved, and what's wrong shows inline.
 */
export function IcsDialog({
  editing,
  onClose,
}: {
  /** The subscription to change; absent to add one. */
  editing?: IcsSubscription;
  onClose: () => void;
}) {
  const t = useT();
  const c = t.calendar;
  const subscriptions = useSubscriptions();
  const store = useUiStore();
  const titleId = useId();
  const urlId = useId();
  const nameId = useId();
  const errorId = useId();
  const hintId = useId();
  const [url, setUrl] = useState(editing?.url ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState(
    editing?.color ??
      SUBSCRIPTION_COLORS[
        store.getState().settings.icsCalendars.length %
          SUBSCRIPTION_COLORS.length
      ] ??
      "#8e24aa",
  );
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checking) return;
    setChecking(true);
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    subscriptions
      .save(
        {
          id: editing?.id ?? crypto.randomUUID(),
          url,
          name,
          color,
        },
        controller.signal,
      )
      .then(
        (saved) => {
          if (!editing)
            store
              .getState()
              .showToast({ message: c.added(saved.name), tone: "info" });
          onClose();
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setChecking(false);
          setError(errorMessage(cause, t));
        },
      );
  };

  return (
    <Sheet labelledBy={titleId} onEscape={close}>
      <form onSubmit={submit} className="flex min-h-0 flex-col" noValidate>
        <div className="space-y-4 overflow-y-auto p-4">
          <h2 id={titleId} className="text-base font-semibold">
            {editing ? c.editTitle(editing.name) : c.addTitle}
          </h2>
          <div className="space-y-1">
            <label htmlFor={urlId} className="text-sm font-medium">
              {c.url}
            </label>
            <input
              id={urlId}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(undefined);
              }}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              data-initial-focus=""
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${errorId} ${hintId}` : hintId}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <p id={hintId} className="text-xs text-zinc-500">
              {c.urlHint}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-sm font-medium">
              {c.name}
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              autoComplete="off"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{c.colour}</legend>
            <div className="flex flex-wrap gap-2">
              {SUBSCRIPTION_COLORS.map((option) => {
                const label = colorName(option, t.labels.colours);
                return (
                  <label key={option} title={label} className="relative">
                    <input
                      type="radio"
                      name="ics-colour"
                      aria-label={label}
                      checked={color === option}
                      onChange={() => {
                        setColor(option);
                      }}
                      className="peer absolute inset-0 opacity-0"
                    />
                    <span
                      aria-hidden="true"
                      className="block size-7 rounded-full ring-offset-2 peer-checked:ring-2 peer-checked:ring-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 dark:ring-offset-zinc-900 pointer-coarse:size-11"
                      style={{ background: option }}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
          {error && (
            <p
              id={errorId}
              role="alert"
              className="text-sm text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {t.common.cancel}
          </button>
          <button
            type="submit"
            disabled={checking}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {checking ? c.checking : editing ? c.save : c.add}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
