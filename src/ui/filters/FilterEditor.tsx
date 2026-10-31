import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  hasActions,
  hasConditions,
  type FilterConditions,
  type FilterSetup,
  type FilterSpec,
} from "../../core/filters";
import type { AccountId, MailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import {
  MAX_FILTER_MATCHES,
  useFilterMatches,
  type FilterMatches,
} from "../../data/filterMatches";
import type { FilterTarget } from "../../data/filters";
import { mailboxPath } from "../../data/mailboxActions";
import { useT } from "../../i18n/context";
import { errorMessage } from "../common/errorMessage";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { textOf, valuesOf } from "./describe";
import {
  BUTTON,
  CHECK,
  CHECK_ROW,
  CONTROL,
  FIELD,
  HINT,
  LINK,
  PRIMARY,
} from "./styles";
import { useSaveShortcut } from "./useSaveShortcut";

const KB = 1024;
const MB = 1024 * 1024;
/** Gmail's forwarding settings, where forwarding addresses are added and verified. */
const GMAIL_FORWARDING_URL =
  "https://mail.google.com/mail/u/0/#settings/fwdandpop";

/** What the editor's fields hold. */
interface Form {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly words: string;
  readonly notWords: string;
  readonly hasAttachment: boolean;
  readonly sizeCompare: "" | "larger" | "smaller";
  readonly sizeValue: string;
  readonly sizeUnit: "kb" | "mb";
  readonly skipInbox: boolean;
  readonly move: boolean;
  readonly moveTo: string;
  readonly labels: readonly MailboxId[];
  readonly markRead: boolean;
  readonly star: boolean;
  readonly forward: boolean;
  readonly forwardTo: string;
  readonly trash: boolean;
  readonly neverSpam: boolean;
  readonly stop: boolean;
}

function formOf(spec: FilterSpec): Form {
  const { conditions: c, actions: a } = spec;
  const bytes = c.size?.bytes ?? 0;
  const inMb = bytes >= MB && bytes % MB === 0;
  return {
    name: spec.name ?? "",
    from: textOf(c.from),
    to: textOf(c.to),
    subject: textOf(c.subject),
    words: textOf(c.words),
    notWords: textOf(c.notWords),
    hasAttachment: c.hasAttachment,
    sizeCompare: c.size?.compare ?? "",
    sizeValue: c.size
      ? String(inMb ? bytes / MB : Math.max(1, Math.round(bytes / KB)))
      : "",
    sizeUnit: inMb ? "mb" : "kb",
    skipInbox: a.skipInbox,
    move: a.moveTo !== undefined,
    moveTo: a.moveTo ?? "",
    labels: a.labels,
    markRead: a.markRead,
    star: a.star,
    forward: a.forwardTo.length > 0,
    forwardTo: textOf(a.forwardTo),
    trash: a.trash,
    neverSpam: a.neverSpam,
    stop: a.stop,
  };
}

function conditionsOf(form: Form): FilterConditions {
  const size = Number(form.sizeValue);
  return {
    from: valuesOf(form.from),
    to: valuesOf(form.to),
    subject: valuesOf(form.subject),
    words: valuesOf(form.words),
    notWords: valuesOf(form.notWords),
    hasAttachment: form.hasAttachment,
    ...(form.sizeCompare !== "" && Number.isFinite(size) && size > 0
      ? {
          size: {
            compare: form.sizeCompare,
            bytes: Math.round(size * (form.sizeUnit === "mb" ? MB : KB)),
          },
        }
      : {}),
  };
}

function specOf(form: Form, enabled: boolean): FilterSpec {
  return {
    ...(form.name.trim() === "" ? {} : { name: form.name.trim() }),
    enabled,
    conditions: conditionsOf(form),
    actions: {
      skipInbox: form.skipInbox,
      ...(form.move && form.moveTo !== ""
        ? { moveTo: form.moveTo as MailboxId }
        : {}),
      labels: form.labels,
      markRead: form.markRead,
      star: form.star,
      forwardTo: form.forward ? valuesOf(form.forwardTo) : [],
      trash: form.trash,
      neverSpam: form.neverSpam,
      stop: form.stop,
    },
  };
}

/** What's still missing before the filter can be saved. */
type Problem =
  "needsCondition" | "needsAction" | "needsFolder" | "needsForward";

function problemOf(form: Form, spec: FilterSpec): Problem | undefined {
  if (!hasConditions(spec.conditions)) return "needsCondition";
  if (form.move && form.moveTo === "") return "needsFolder";
  if (form.forward && spec.actions.forwardTo.length === 0)
    return "needsForward";
  if (!hasActions(spec.actions)) return "needsAction";
  return undefined;
}

/** The actions change mail that is already there (forwarding doesn't). */
function actsOnExisting(spec: FilterSpec): boolean {
  const a = spec.actions;
  return (
    a.skipInbox ||
    a.moveTo !== undefined ||
    a.labels.length > 0 ||
    a.markRead ||
    a.star ||
    a.trash
  );
}

/** Props of {@link FilterEditor}. */
export interface FilterEditorProps {
  readonly accountId: AccountId;
  readonly setup: FilterSetup;
  /** The account's mailboxes, names in the interface language. */
  readonly mailboxes: readonly Mailbox[];
  readonly target: FilterTarget;
  readonly initial: FilterSpec;
  /** Saves; rejects with why it wasn't saved. */
  readonly onSave: (
    spec: FilterSpec,
    matches: FilterMatches | undefined,
  ) => Promise<void>;
  /** Cancel, Escape or the backdrop (the caller asks about changes). */
  readonly onClose: () => void;
  /** Reports whether anything was changed. */
  readonly onDirty: (dirty: boolean) => void;
}

/**
 * Creating or changing a filter: conditions, then actions in the
 * account's words, then "Also apply to N matching messages".
 */
export function FilterEditor({
  accountId,
  setup,
  mailboxes,
  target,
  initial,
  onSave,
  onClose,
  onDirty,
}: FilterEditorProps) {
  const t = useT();
  const f = t.filters;
  const id = useId();
  const { capabilities } = setup;
  const can = (action: (typeof capabilities.actions)[number]) =>
    capabilities.actions.includes(action);
  const shows = (condition: (typeof capabilities.conditions)[number]) =>
    capabilities.conditions.includes(condition);
  const start = useMemo(() => formOf(initial), [initial]);
  const [form, setForm] = useState(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tried, setTried] = useState(false);
  const [apply, setApply] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  const dirtyChanged = useRef(onDirty);
  useEffect(() => {
    dirtyChanged.current = onDirty;
  });
  useEffect(() => {
    dirtyChanged.current(dirty);
  }, [dirty]);

  const spec = specOf(form, initial.enabled);
  const problem = problemOf(form, spec);

  // Counting matches waits until typing pauses.
  const conditionsKey = JSON.stringify(spec.conditions);
  const [counted, setCounted] = useState<FilterConditions | undefined>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setCounted(JSON.parse(conditionsKey) as FilterConditions);
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [conditionsKey]);
  const offerApply = actsOnExisting(spec) && hasConditions(spec.conditions);
  const matches = useFilterMatches(
    accountId,
    offerApply ? counted : undefined,
    capabilities.scope,
  );

  const folders = mailboxes.filter(
    (mailbox) =>
      mailbox.kind === "folder" &&
      mailbox.assignable &&
      mailbox.role !== "inbox" &&
      mailbox.role !== "drafts" &&
      mailbox.role !== "sent" &&
      mailbox.role !== "trash",
  );
  const labels = mailboxes.filter(
    (mailbox) =>
      mailbox.kind === "label" &&
      mailbox.assignable &&
      mailbox.role === undefined,
  );
  const pathOf = (mailbox: Mailbox) =>
    mailboxPath(mailbox, mailboxes).join(" / ");
  const nameOf = (mailboxId: MailboxId) => {
    const mailbox = mailboxes.find((candidate) => candidate.id === mailboxId);
    return mailbox ? pathOf(mailbox) : mailboxId;
  };
  const categories = !can("skipInbox");

  const save = async () => {
    setTried(true);
    if (problem || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(
        spec,
        apply && offerApply && counted !== undefined && matches.data
          ? matches.data
          : undefined,
      );
    } catch (failure) {
      setError(errorMessage(failure, t));
      setSaving(false);
    }
  };

  const formRef = useRef<HTMLFormElement>(null);
  useSaveShortcut(formRef, () => void save());

  const title = capabilities.names
    ? target.kind === "new"
      ? f.newRuleTitle
      : f.editRuleTitle
    : target.kind === "new"
      ? f.newTitle
      : f.editTitle;

  const field = (
    key: "from" | "to" | "subject" | "words" | "notWords",
    label: string,
    initialFocus = false,
  ) =>
    shows(key) && (
      <div className="space-y-1">
        <label htmlFor={`${id}-${key}`} className="block text-sm font-medium">
          {label}
        </label>
        <input
          id={`${id}-${key}`}
          value={form[key]}
          onChange={(event) => {
            set(key, event.target.value);
          }}
          className={FIELD}
          {...(initialFocus ? { "data-initial-focus": true } : {})}
        />
      </div>
    );

  const check = (
    key:
      | "skipInbox"
      | "markRead"
      | "star"
      | "trash"
      | "neverSpam"
      | "stop"
      | "hasAttachment",
    label: string,
  ) => (
    <label className={CHECK_ROW}>
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(event) => {
          set(key, event.target.checked);
        }}
        className={CHECK}
      />
      <span>{label}</span>
    </label>
  );

  const count = matches.data?.messages.length ?? 0;
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
            {title}
          </h2>
          <IconButton label={f.cancel} icon="x" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {capabilities.names && (
            <div className="space-y-1">
              <label
                htmlFor={`${id}-name`}
                className="block text-sm font-medium"
              >
                {f.name}
              </label>
              <input
                id={`${id}-name`}
                value={form.name}
                placeholder={f.namePlaceholder}
                onChange={(event) => {
                  set("name", event.target.value);
                }}
                className={FIELD}
              />
            </div>
          )}

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">
              {f.conditions}
            </legend>
            <p className={HINT}>{f.severalHint}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {field("from", f.from, true)}
              {field("to", f.to)}
              {field("subject", f.subject)}
              {field("words", f.words)}
              {field("notWords", f.notWords)}
            </div>
            {shows("hasAttachment") && check("hasAttachment", f.hasAttachment)}
            {shows("size") && (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${id}-size`} className="text-sm font-medium">
                  {f.size}
                </label>
                <select
                  id={`${id}-size`}
                  value={form.sizeCompare}
                  onChange={(event) => {
                    set(
                      "sizeCompare",
                      event.target.value as Form["sizeCompare"],
                    );
                  }}
                  className={CONTROL}
                >
                  <option value="">{f.sizeAny}</option>
                  <option value="larger">{f.larger}</option>
                  <option value="smaller">{f.smaller}</option>
                </select>
                {form.sizeCompare !== "" && (
                  <>
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      aria-label={`${f.sizeValue} ${form.sizeUnit === "mb" ? f.mb : f.kb}`}
                      value={form.sizeValue}
                      onChange={(event) => {
                        set("sizeValue", event.target.value);
                      }}
                      className={`${CONTROL} w-24`}
                    />
                    <select
                      aria-label={f.sizeValue}
                      value={form.sizeUnit}
                      onChange={(event) => {
                        set("sizeUnit", event.target.value as "kb" | "mb");
                      }}
                      className={CONTROL}
                    >
                      <option value="kb">{f.kb}</option>
                      <option value="mb">{f.mb}</option>
                    </select>
                  </>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">{f.actions}</legend>
            {can("skipInbox") && check("skipInbox", f.skipInbox)}
            {can("moveTo") && (
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <label className={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked={form.move}
                    onChange={(event) => {
                      set("move", event.target.checked);
                    }}
                    className={CHECK}
                  />
                  <span>{f.moveTo}</span>
                </label>
                {form.move && (
                  <select
                    aria-label={f.moveTo}
                    value={form.moveTo}
                    onChange={(event) => {
                      set("moveTo", event.target.value);
                    }}
                    className={CONTROL}
                  >
                    <option value="" disabled>
                      {f.needsFolder}
                    </option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {pathOf(folder)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {can("labels") && (
              <div className="space-y-1">
                <p className="text-sm">
                  {categories ? f.categorize : f.applyLabels}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.labels.map((labelId) => (
                    <span
                      key={labelId}
                      className="flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-0.5 pl-2.5 text-sm dark:bg-zinc-800"
                    >
                      {nameOf(labelId)}
                      <IconButton
                        label={f.removeValue(nameOf(labelId))}
                        icon="x"
                        onClick={() => {
                          set(
                            "labels",
                            form.labels.filter((other) => other !== labelId),
                          );
                        }}
                      />
                    </span>
                  ))}
                  <select
                    aria-label={categories ? f.addCategory : f.addLabel}
                    value=""
                    onChange={(event) => {
                      const chosen = event.target.value as MailboxId;
                      if (chosen && !form.labels.includes(chosen))
                        set("labels", [...form.labels, chosen]);
                    }}
                    className={CONTROL}
                  >
                    <option value="">
                      {categories ? f.addCategory : f.addLabel}
                    </option>
                    {labels
                      .filter((label) => !form.labels.includes(label.id))
                      .map((label) => (
                        <option key={label.id} value={label.id}>
                          {pathOf(label)}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            )}
            {can("markRead") && check("markRead", f.markRead)}
            {can("star") && check("star", f.star)}
            {can("forwardTo") && (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <label className={CHECK_ROW}>
                    <input
                      type="checkbox"
                      checked={form.forward}
                      disabled={
                        capabilities.forward === "verified" &&
                        (setup.forwardAddresses ?? []).length === 0 &&
                        !form.forward
                      }
                      onChange={(event) => {
                        const on = event.target.checked;
                        setForm((current) => ({
                          ...current,
                          forward: on,
                          forwardTo:
                            on &&
                            current.forwardTo === "" &&
                            capabilities.forward === "verified"
                              ? (setup.forwardAddresses?.[0] ?? "")
                              : current.forwardTo,
                        }));
                      }}
                      className={CHECK}
                    />
                    <span>{f.forwardTo}</span>
                  </label>
                  {form.forward &&
                    (capabilities.forward === "verified" ? (
                      <select
                        aria-label={f.forwardTo}
                        value={form.forwardTo}
                        onChange={(event) => {
                          set("forwardTo", event.target.value);
                        }}
                        className={CONTROL}
                      >
                        {[
                          ...new Set([
                            ...(setup.forwardAddresses ?? []),
                            ...valuesOf(form.forwardTo),
                          ]),
                        ].map((address) => (
                          <option key={address} value={address}>
                            {address}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        inputMode="email"
                        aria-label={f.forwardAddresses}
                        value={form.forwardTo}
                        onChange={(event) => {
                          set("forwardTo", event.target.value);
                        }}
                        className={`${CONTROL} min-w-0 flex-1 sm:max-w-sm`}
                      />
                    ))}
                </div>
                {capabilities.forward === "verified" &&
                (setup.forwardAddresses ?? []).length === 0 ? (
                  <p className={HINT}>
                    {f.noVerifiedAddress}{" "}
                    <a
                      href={GMAIL_FORWARDING_URL}
                      target="_blank"
                      rel="noreferrer"
                      className={LINK}
                    >
                      {f.gmailForwarding}
                    </a>
                  </p>
                ) : (
                  form.forward &&
                  capabilities.forward === "any" && (
                    <p className={HINT}>{f.forwardNote}</p>
                  )
                )}
              </div>
            )}
            {can("trash") && check("trash", f.trash)}
            {can("neverSpam") && check("neverSpam", f.neverSpam)}
            {can("stop") && check("stop", f.stop)}
          </fieldset>

          {target.kind === "edit" && target.filter.more && (
            <p className={HINT}>{f.more}</p>
          )}

          {offerApply && (
            <div className="space-y-1 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
              {matches.isFetching || counted === undefined ? (
                <p className={HINT} role="status">
                  {f.countingMatches}
                </p>
              ) : count === 0 ? (
                <p className={HINT} role="status">
                  {f.noMatches}
                </p>
              ) : (
                <label className={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked={apply}
                    onChange={(event) => {
                      setApply(event.target.checked);
                    }}
                    className={CHECK}
                  />
                  <span>
                    {matches.data?.capped
                      ? f.applyExistingCapped(
                          new Intl.NumberFormat(t.locale).format(
                            MAX_FILTER_MATCHES,
                          ),
                        )
                      : f.applyExisting(count)}
                  </span>
                </label>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          {(error ?? (tried && problem)) && (
            <p
              role="alert"
              className="mr-auto min-w-0 text-sm text-red-700 dark:text-red-400"
            >
              {error ?? (problem ? f[problem] : "")}
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
