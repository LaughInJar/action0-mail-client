import { useId, useState } from "react";
import type { ContactGroup } from "../../core/contacts";
import type { ContactSource } from "../../data/contacts";
import { useT } from "../../i18n/context";
import { errorMessage } from "../common/errorMessage";
import { BUTTON, FIELD, HINT, PRIMARY } from "../common/formStyles";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { colorName } from "../labels/colorName";
import { useContactActions } from "./useContactActions";

/**
 * A group's name and colour: a new group, or one being renamed or
 * recoloured. Outlook categories can't be renamed (the field says so);
 * only sources with colours offer them. While vCard categories are
 * rewritten card by card, it shows how far that is.
 */
export function GroupDialog({
  source,
  group,
  onClose,
}: {
  source: ContactSource;
  /** The group to change; none: a new one. */
  group?: ContactGroup;
  onClose: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const actions = useContactActions();
  const capabilities = source.provider.capabilities;
  const colors = capabilities.groupColors ?? [];
  const renamable = !group || capabilities.renameGroups;
  const [name, setName] = useState(group?.name ?? "");
  const [colorId, setColorId] = useState(group?.colorId ?? colors[0]?.id);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    // The permission popup (Google) has to open within the click.
    if (!(await actions.ensureWritable(source))) return;
    setProgress("");
    setError(null);
    try {
      if (group)
        await actions.changeGroup(
          source,
          group,
          {
            ...(renamable ? { name: trimmed } : {}),
            ...(colorId === undefined ? {} : { colorId }),
          },
          (done, total) => {
            setProgress(c.updating(done, total));
          },
        );
      else await actions.addGroup(source, trimmed, colorId);
      onClose();
    } catch (cause) {
      setProgress(null);
      setError(c.couldntSave(errorMessage(cause, t)));
    }
  };

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onClose}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
          <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
            {group ? c.editGroup : c.newGroup}
          </h2>
          <IconButton label={c.cancel} icon="x" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-1">
            <label htmlFor={`${id}-name`} className="block text-sm font-medium">
              {c.groupName}
            </label>
            <input
              id={`${id}-name`}
              value={name}
              disabled={!renamable || busy}
              data-initial-focus={renamable ? true : undefined}
              placeholder={c.newGroupPlaceholder}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className={FIELD}
            />
            {!renamable && <p className={HINT}>{c.cantRename}</p>}
          </div>
          {colors.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{c.colour}</legend>
              <div className="flex flex-wrap gap-2">
                {colors.map((color) => (
                  <label
                    key={color.id}
                    className="relative grid size-8 cursor-pointer place-items-center rounded-full pointer-coarse:size-11"
                    style={{ backgroundColor: color.color }}
                    title={colorName(color.color, t.labels.colours)}
                  >
                    <input
                      type="radio"
                      name={`${id}-colour`}
                      value={color.id}
                      checked={colorId === color.id}
                      disabled={busy}
                      aria-label={colorName(color.color, t.labels.colours)}
                      onChange={() => {
                        setColorId(color.id);
                      }}
                      className="peer absolute inset-0 cursor-pointer opacity-0"
                    />
                    <Icon
                      name="check"
                      className="invisible size-4 text-white drop-shadow peer-checked:visible"
                    />
                    <span className="pointer-events-none absolute inset-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2" />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {progress && (
            <p role="status" className={HINT}>
              {progress}
            </p>
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
            {c.cancel}
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={PRIMARY}
          >
            {busy ? c.saving : c.save}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
