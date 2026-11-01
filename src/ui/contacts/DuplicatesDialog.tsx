import { useId, useMemo, useState } from "react";
import {
  fieldsOf,
  findDuplicates,
  fitTo,
  mergeFields,
  nameOf,
  type Contact,
  type ContactFields,
} from "../../core/contacts";
import { canChangeContact, type ContactSourceState } from "../../data/contacts";
import { useT } from "../../i18n/context";
import { BUTTON, HINT, PRIMARY } from "../common/formStyles";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { ContactAvatar } from "./ContactAvatar";
import { useContactActions } from "./useContactActions";

/** One line of what a merged contact has ("anna@x, +43 …"). */
function summaryOf(fields: ContactFields): string {
  return [
    ...fields.emails.map((email) => email.value),
    ...fields.phones.map((phone) => phone.value),
    fields.organization.company,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * "Find duplicates" of one account: each set of contacts that look like
 * the same person, why, and what merging them makes; Merge or Merge all
 * (undoable).
 */
export function DuplicatesDialog({
  state,
  onClose,
}: {
  state: ContactSourceState;
  onClose: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const actions = useContactActions();
  const [busy, setBusy] = useState(false);
  const { source, snapshot } = state;
  const sets = useMemo(
    () =>
      findDuplicates(snapshot?.contacts ?? []).filter((set) =>
        set.contacts.every((contact) => canChangeContact(state, contact)),
      ),
    [snapshot, state],
  );
  const capabilities = source.provider.capabilities;

  const run = async (merge: () => Promise<unknown>) => {
    if (busy) return;
    // The permission popup (Google) has to open within the click.
    if (!(await actions.ensureWritable(source))) return;
    setBusy(true);
    try {
      await merge();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onClose} size="page">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
          {c.duplicatesTitle(source.label)}
        </h2>
        <IconButton label={c.close} icon="x" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {sets.length === 0 && <p className="text-sm">{c.noDuplicates}</p>}
        {sets.map((set) => {
          const [keep, ...others] = set.contacts;
          if (!keep) return null;
          const fitted = fitTo(
            capabilities,
            mergeFields(fieldsOf(keep), others.map(fieldsOf)),
          );
          const key = set.contacts.map((contact) => contact.id).join(" ");
          return (
            <section
              key={key}
              aria-label={nameOf(keep) || c.unnamed}
              className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {c.reasons[set.reason]}
              </p>
              <ul className="space-y-2">
                {set.contacts.map((contact: Contact) => (
                  <li key={contact.id} className="flex items-center gap-3">
                    <ContactAvatar
                      source={source}
                      contact={contact}
                      name={nameOf(contact)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {nameOf(contact) || c.unnamed}
                      </div>
                      <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {summaryOf(contact)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="rounded-md bg-zinc-100 p-2 text-sm dark:bg-zinc-900">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {c.mergedPreview}{" "}
                </span>
                <span className="font-medium">{nameOf(keep) || c.unnamed}</span>
                <div className="text-xs break-words text-zinc-600 dark:text-zinc-300">
                  {summaryOf(fitted.fields)}
                </div>
                {fitted.dropped && <p className={HINT}>{c.dropsValues}</p>}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(() => actions.merge(source, set.contacts));
                }}
                className={BUTTON}
              >
                {c.merge}
              </button>
            </section>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <button type="button" onClick={onClose} className={BUTTON}>
          {c.close}
        </button>
        {sets.length > 1 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void run(() =>
                actions.mergeAll(
                  source,
                  sets.map((set) => set.contacts),
                ),
              );
            }}
            className={PRIMARY}
          >
            {c.mergeAll(sets.length)}
          </button>
        )}
      </div>
    </Sheet>
  );
}
