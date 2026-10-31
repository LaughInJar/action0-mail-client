import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AutoReply, AutoReplyCapabilities } from "../../core/filters";
import { useT } from "../../i18n/context";
import { RichTextEditor } from "../composer/RichTextEditor";
import { ChoiceGroup } from "../settings/controls";
import { errorMessage } from "../common/errorMessage";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import {
  BUTTON,
  CHECK,
  CHECK_ROW,
  CONTROL,
  FIELD,
  HINT,
  PRIMARY,
} from "./styles";
import { useSaveShortcut } from "./useSaveShortcut";

/** Props of {@link AutoReplyEditor}. */
export interface AutoReplyEditorProps {
  readonly capabilities: AutoReplyCapabilities;
  readonly initial: AutoReply;
  /** Saves; rejects with why it wasn't saved. */
  readonly onSave: (reply: AutoReply) => Promise<void>;
  /** Cancel, Escape or the backdrop (the caller asks about changes). */
  readonly onClose: () => void;
  /** Reports whether anything was changed. */
  readonly onDirty: (dirty: boolean) => void;
}

/**
 * The automatic reply (out of office): on or off, the days it answers,
 * the subject and message, and who gets it, as far as the server has them.
 */
export function AutoReplyEditor({
  capabilities,
  initial,
  onSave,
  onClose,
  onDirty,
}: AutoReplyEditorProps) {
  const t = useT();
  const f = t.filters;
  const id = useId();
  const start = useMemo(
    () => ({
      ...initial,
      // A switched-off reply is opened to switch it on.
      enabled: true,
    }),
    [initial],
  );
  const [reply, setReply] = useState<AutoReply>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const set = <K extends keyof AutoReply>(key: K, value: AutoReply[K]) => {
    setReply((current) => ({ ...current, [key]: value }));
  };

  const dirty = JSON.stringify(reply) !== JSON.stringify(start);
  const dirtyChanged = useRef(onDirty);
  useEffect(() => {
    dirtyChanged.current = onDirty;
  });
  useEffect(() => {
    dirtyChanged.current(dirty);
  }, [dirty]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    const { start: first, end: last, outside, ...rest } = reply;
    try {
      await onSave({
        ...rest,
        ...(capabilities.schedule && first ? { start: first } : {}),
        ...(capabilities.schedule && last ? { end: last } : {}),
        ...(capabilities.outside && outside ? { outside } : {}),
      });
    } catch (failure) {
      setError(errorMessage(failure, t));
      setSaving(false);
    }
  };

  const formRef = useRef<HTMLFormElement>(null);
  useSaveShortcut(formRef, () => void save());

  const outside = reply.outside ?? { audience: "none" as const, text: "" };
  const message = (
    key: "inside" | "outside",
    label: string,
    /** What the rich text editor starts with (it keeps its own state). */
    first: string,
    value: string,
    onChange: (text: string) => void,
  ) =>
    capabilities.html ? (
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="flex h-44 flex-col overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          <RichTextEditor
            id={`${id}-${key}`}
            label={label}
            placeholder={f.replyPlaceholder}
            initialHtml={first}
            focusOnOpen={false}
            onChange={onChange}
          />
        </div>
      </div>
    ) : (
      <div className="space-y-1">
        <label htmlFor={`${id}-${key}`} className="block text-sm font-medium">
          {label}
        </label>
        <textarea
          id={`${id}-${key}`}
          rows={6}
          value={value}
          placeholder={f.replyPlaceholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={FIELD}
        />
      </div>
    );

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onClose} size="page">
      <form
        ref={formRef}
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
          <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
            {f.autoReplyTitle}
          </h2>
          <IconButton label={f.cancel} icon="x" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <label className={CHECK_ROW}>
            <input
              type="checkbox"
              role="switch"
              checked={reply.enabled}
              onChange={(event) => {
                set("enabled", event.target.checked);
              }}
              className={CHECK}
              data-initial-focus
            />
            <span className="font-medium">{f.sendAutoReplies}</span>
          </label>
          {capabilities.schedule && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor={`${id}-first`}
                    className="block text-sm font-medium"
                  >
                    {f.firstDay}
                  </label>
                  <input
                    id={`${id}-first`}
                    type="date"
                    value={reply.start ?? ""}
                    onChange={(event) => {
                      setReply(({ start: _start, ...current }) =>
                        event.target.value
                          ? { ...current, start: event.target.value }
                          : current,
                      );
                    }}
                    className={CONTROL}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor={`${id}-last`}
                    className="block text-sm font-medium"
                  >
                    {f.lastDay}
                  </label>
                  <input
                    id={`${id}-last`}
                    type="date"
                    value={reply.end ?? ""}
                    min={reply.start}
                    onChange={(event) => {
                      setReply(({ end: _end, ...current }) =>
                        event.target.value
                          ? { ...current, end: event.target.value }
                          : current,
                      );
                    }}
                    className={CONTROL}
                  />
                </div>
              </div>
              <p className={HINT}>{f.scheduleHint}</p>
            </div>
          )}
          {capabilities.subject && (
            <div className="space-y-1">
              <label
                htmlFor={`${id}-subject`}
                className="block text-sm font-medium"
              >
                {f.replySubject}
              </label>
              <input
                id={`${id}-subject`}
                value={reply.subject}
                onChange={(event) => {
                  set("subject", event.target.value);
                }}
                className={FIELD}
              />
            </div>
          )}
          {message(
            "inside",
            capabilities.outside ? f.replyMessageInside : f.replyMessage,
            initial.text,
            reply.text,
            (text) => {
              set("text", text);
            },
          )}
          {capabilities.contactsOnly && (
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={reply.contactsOnly}
                onChange={(event) => {
                  set("contactsOnly", event.target.checked);
                }}
                className={CHECK}
              />
              <span>{f.contactsOnly}</span>
            </label>
          )}
          {capabilities.outside && (
            <>
              <ChoiceGroup
                legend={f.outside}
                value={outside.audience}
                choices={[
                  { value: "none", label: f.outsideNone },
                  { value: "contacts", label: f.outsideContacts },
                  { value: "all", label: f.outsideAll },
                ]}
                onChange={(audience) => {
                  set("outside", { ...outside, audience });
                }}
              />
              {outside.audience !== "none" &&
                message(
                  "outside",
                  f.replyMessageOutside,
                  initial.outside?.text ?? "",
                  outside.text,
                  (text) => {
                    setReply((current) => ({
                      ...current,
                      outside: {
                        audience: current.outside?.audience ?? "all",
                        text,
                      },
                    }));
                  },
                )}
            </>
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
          <button type="button" onClick={onClose} className={BUTTON}>
            {f.cancel}
          </button>
          <button type="submit" disabled={saving} className={PRIMARY}>
            {saving ? f.saving : f.save}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
