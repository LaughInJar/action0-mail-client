import { useState } from "react";
import type { FilterSetup, MailFilter } from "../../core/filters";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { useT } from "../../i18n/context";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { describeFilter } from "./describe";
import { HINT } from "./styles";
import type { FilterActions } from "./useFilterActions";

/** Props of {@link FilterList}. */
export interface FilterListProps {
  readonly accountId: AccountId;
  readonly setup: FilterSetup;
  readonly mailboxes: readonly Mailbox[];
  /** Changes aren't allowed (Gmail without the settings permission). */
  readonly readOnly: boolean;
  readonly onEdit: (filter: MailFilter) => void;
  readonly actions: FilterActions;
}

/**
 * An account's filters in the order the server runs them: a summary, an
 * on/off switch, Edit and Delete, and where the order matters Move up /
 * Move down (and dragging with a mouse).
 */
export function FilterList({
  accountId,
  setup,
  mailboxes,
  readOnly,
  onEdit,
  actions,
}: FilterListProps) {
  const t = useT();
  const f = t.filters;
  const { filters, capabilities } = setup;
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const reorder = capabilities.order && !readOnly && filters.length > 1;

  if (filters.length === 0) return <p className={HINT}>{f.noFilters}</p>;
  return (
    <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {filters.map((filter, index) => {
        const summary = describeFilter(filter, capabilities, mailboxes, t);
        const title =
          filter.custom !== undefined
            ? f.custom
            : capabilities.names
              ? filter.name?.trim() || f.unnamed
              : undefined;
        const editable = !readOnly && filter.custom === undefined;
        return (
          // Dragging is a mouse extra; Move up/down do the same by keyboard and touch.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <li
            key={filter.id}
            draggable={reorder}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              setDragged(index);
            }}
            onDragOver={(event) => {
              if (dragged === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDragLeave={() => {
              setOver((current) => (current === index ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged !== null)
                actions.move(accountId, filters, dragged, index);
              setDragged(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            className={`flex items-start gap-2 p-2 ${
              over === index && dragged !== null && dragged !== index
                ? "bg-blue-50 dark:bg-blue-500/15"
                : ""
            } ${filter.enabled ? "" : "text-zinc-500 dark:text-zinc-400"}`}
          >
            {reorder && (
              <span
                title={f.dragHint}
                className="mt-1 hidden cursor-grab text-zinc-400 pointer-fine:block"
              >
                <Icon name="grip" />
              </span>
            )}
            {capabilities.toggle && (
              <input
                type="checkbox"
                role="switch"
                aria-label={`${f.on}: ${title ?? summary.conditions}`}
                checked={filter.enabled}
                disabled={readOnly}
                onChange={(event) => {
                  actions.setEnabled(accountId, filter, event.target.checked);
                }}
                className="mt-1 size-4 shrink-0 accent-blue-600 pointer-coarse:mt-3"
              />
            )}
            <div className="min-w-0 flex-1 py-0.5">
              {title && <p className="truncate text-sm font-medium">{title}</p>}
              {filter.custom !== undefined ? (
                <>
                  <p className="truncate font-mono text-xs">
                    {filter.custom.trim().split("\n")[0]}
                  </p>
                  <p className={HINT}>{f.customHint}</p>
                </>
              ) : (
                <p className="text-sm">
                  <span>{summary.conditions}</span>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only">: </span>
                  <span>{summary.actions}</span>
                </p>
              )}
              {filter.problem && (
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {filter.problem === "error" ? f.ruleError : f.ruleReadOnly}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end">
              {reorder && (
                <>
                  <IconButton
                    label={f.moveUp}
                    icon="chevron-up"
                    disabled={index === 0}
                    onClick={() => {
                      actions.move(accountId, filters, index, index - 1);
                    }}
                  />
                  <IconButton
                    label={f.moveDown}
                    icon="chevron-down"
                    disabled={index === filters.length - 1}
                    onClick={() => {
                      actions.move(accountId, filters, index, index + 1);
                    }}
                  />
                </>
              )}
              {editable && filter.problem !== "readOnly" && (
                <IconButton
                  label={f.edit}
                  icon="pencil"
                  onClick={() => {
                    onEdit(filter);
                  }}
                />
              )}
              {!readOnly && (
                <IconButton
                  label={f.delete}
                  icon="trash"
                  danger
                  onClick={() => {
                    void actions.remove(accountId, filters, filter);
                  }}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
