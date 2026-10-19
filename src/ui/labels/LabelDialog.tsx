import { useId, useState, type SubmitEvent } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { MailboxId } from "../../core/ids";
import type { Mailbox, MailboxColor } from "../../core/model";
import type { MailboxChange } from "../../core/provider";
import { findMailbox } from "../../data/hooks";
import { isNestable, mailboxPath, subtreeIds } from "../../data/mailboxActions";
import { useUi } from "../../state/context";
import type { LabelDialogState } from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import { Sheet } from "../common/Sheet";
import { colorName } from "./colorName";
import { useLabelActions } from "./useLabelActions";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";
import { mailboxTexts } from "./mailboxTexts";

/** Shows the label dialog while one is open. */
export function LabelDialogHost() {
  const dialog = useUi((state) => state.labelDialog);
  const { data: mailboxes } = useMailboxList(dialog?.accountId);
  if (!dialog || !mailboxes) return null;
  const editing =
    dialog.mode === "edit"
      ? findMailbox(mailboxes, dialog.mailboxId)
      : undefined;
  if (dialog.mode === "edit" && !editing) return null;
  return (
    <LabelDialog
      key={JSON.stringify(dialog)}
      dialog={dialog}
      mailboxes={mailboxes}
      editing={editing}
    />
  );
}

const sameColor = (
  a: MailboxColor | null | undefined,
  b: MailboxColor | null | undefined,
) =>
  (a ?? undefined)?.background.toLowerCase() ===
    (b ?? undefined)?.background.toLowerCase() &&
  (a ?? undefined)?.text.toLowerCase() === (b ?? undefined)?.text.toLowerCase();

interface LabelDialogProps {
  readonly dialog: LabelDialogState;
  readonly mailboxes: readonly Mailbox[];
  /** The label being changed (edit mode). */
  readonly editing: Mailbox | undefined;
}

/**
 * Creates a label or changes one: name, parent, colour and whether the
 * folder list shows it. Enter saves, Esc cancels; what the provider refuses
 * shows inline. Changes end with an undoable toast.
 */
function LabelDialog({ dialog, mailboxes, editing }: LabelDialogProps) {
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const labels = useLabelActions();
  const t = useT();
  const capabilities = useAccountHandle(dialog.accountId)?.provider
    .capabilities;
  const l = mailboxTexts(t, capabilities);
  const palette = capabilities?.mailboxColors ?? [];
  const canHide = capabilities?.hideMailboxes ?? false;
  const titleId = useId();
  const nameId = useId();
  const parentFieldId = useId();
  const errorId = useId();
  const [name, setName] = useState(editing?.name ?? "");
  const [parentId, setParentId] = useState<MailboxId | "">(
    editing
      ? (editing.parentId ?? "")
      : dialog.mode === "create"
        ? (dialog.parentId ?? "")
        : "",
  );
  const [color, setColor] = useState<MailboxColor | null>(
    editing?.color ?? null,
  );
  const [shown, setShown] = useState(!(editing?.hidden ?? false));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const focus = dialog.mode === "edit" ? dialog.focus : "name";

  const close = () => {
    setLabelDialog(null);
  };

  // Parents: anything nestable, except the label itself and what's inside it.
  const excluded = editing
    ? subtreeIds(editing.id, mailboxes)
    : new Set<MailboxId>();
  const parents = mailboxes
    .filter((mailbox) => isNestable(mailbox) && !excluded.has(mailbox.id))
    .map((mailbox) => ({
      mailbox,
      path: mailboxPath(mailbox, mailboxes).join(" / "),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  // A colour from outside the palette (set elsewhere) stays choosable.
  const colors =
    editing?.color && !palette.some((c) => sameColor(c, editing.color))
      ? [...palette, editing.color]
      : palette;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(l.nameMissing);
      return;
    }
    if (trimmed.includes("/")) {
      setError(l.noSlash);
      return;
    }
    const fail = (reason: unknown) => {
      setSaving(false);
      setError(errorMessage(reason, t));
    };
    if (!editing) {
      setSaving(true);
      setError(undefined);
      labels
        .create(
          dialog.accountId,
          {
            name: trimmed,
            ...(parentId === "" ? {} : { parentId }),
            ...(color ? { color } : {}),
            ...(shown ? {} : { hidden: true }),
          },
          { undoable: true },
        )
        .then(close, fail);
      return;
    }
    const change: MailboxChange = {
      ...(trimmed === editing.name ? {} : { name: trimmed }),
      ...((parentId || undefined) === editing.parentId
        ? {}
        : { parentId: parentId || null }),
      ...(sameColor(color, editing.color) ? {} : { color }),
      ...(shown === !editing.hidden ? {} : { hidden: !shown }),
    };
    if (Object.keys(change).length === 0) {
      close();
      return;
    }
    setSaving(true);
    setError(undefined);
    labels.edit(dialog.accountId, editing, change).then(close, fail);
  };

  const preview = name.trim() || l.preview;
  let title = l.newLabel;
  if (editing) title = l.editLabel(editing.name);
  else if (parentId !== "")
    title = l.newLabelIn(findMailbox(mailboxes, parentId)?.name ?? "");

  return (
    <Sheet labelledBy={titleId} onEscape={close}>
      <form onSubmit={submit} className="flex min-h-0 flex-col" noValidate>
        <div className="space-y-4 overflow-y-auto p-4">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-sm font-medium">
              {l.name}
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              data-initial-focus={focus === "name" ? "" : undefined}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={parentFieldId} className="text-sm font-medium">
              {l.inside}
            </label>
            <select
              id={parentFieldId}
              value={parentId}
              onChange={(event) => {
                setParentId(event.target.value as MailboxId | "");
                setError(undefined);
              }}
              data-initial-focus={focus === "parent" ? "" : undefined}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">{l.topLevel}</option>
              {parents.map(({ mailbox, path }) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {path}
                </option>
              ))}
            </select>
          </div>
          {colors.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="flex w-full items-center gap-2 text-sm font-medium">
                {l.colour}
                <span
                  aria-hidden="true"
                  className={`ml-auto max-w-40 truncate rounded px-1.5 py-0.5 text-xs font-medium ${color ? "" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
                  style={
                    color
                      ? { backgroundColor: color.background, color: color.text }
                      : undefined
                  }
                >
                  {preview}
                </span>
              </legend>
              <div className="flex flex-wrap gap-1.5">
                <Swatch
                  label={l.noColour}
                  checked={color === null}
                  onChoose={() => {
                    setColor(null);
                  }}
                  initialFocus={focus === "color" && color === null}
                />
                {colors.map((option) => (
                  <Swatch
                    key={`${option.background}/${option.text}`}
                    label={colorName(option.background, l.colours)}
                    color={option}
                    checked={sameColor(color, option)}
                    onChoose={() => {
                      setColor(option);
                    }}
                    initialFocus={focus === "color" && sameColor(color, option)}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {canHide && (
            <label className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
              <input
                type="checkbox"
                checked={shown}
                onChange={(event) => {
                  setShown(event.target.checked);
                }}
                className="size-4"
              />
              {l.showInList}
            </label>
          )}
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
            disabled={saving}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {saving
              ? t.common.saving
              : editing
                ? t.common.save
                : t.common.create}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

interface SwatchProps {
  readonly label: string;
  readonly color?: MailboxColor;
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly initialFocus: boolean;
}

/** One colour of the colour choice (a native radio button, styled). */
function Swatch({
  label,
  color,
  checked,
  onChoose,
  initialFocus,
}: SwatchProps) {
  return (
    <label title={label} className="relative">
      <input
        type="radio"
        name="label-colour"
        aria-label={label}
        checked={checked}
        onChange={onChoose}
        data-initial-focus={initialFocus ? "" : undefined}
        className="peer absolute inset-0 opacity-0"
      />
      <span
        aria-hidden="true"
        className={`grid size-7 place-items-center rounded-full ring-offset-2 peer-checked:ring-2 peer-checked:ring-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 dark:ring-offset-zinc-900 pointer-coarse:size-11 ${color ? "" : "border border-dashed border-zinc-400 text-zinc-500"}`}
        style={
          color
            ? { backgroundColor: color.background, color: color.text }
            : undefined
        }
      >
        {checked ? (
          <Icon name="check" className="size-3.5" />
        ) : color ? null : (
          <Icon name="x" className="size-3.5" />
        )}
      </span>
    </label>
  );
}
