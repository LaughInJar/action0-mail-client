import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { MailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { mailboxPath } from "../../data/mailboxActions";
import { cachedSummaries, threadMessageIds } from "../../data/mutations";
import { useRoute, useUi } from "../../state/context";
import type { PickerState } from "../../state/uiStore";
import { useMailActions } from "../actions/useMailActions";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import { Sheet } from "../common/Sheet";
import { splitPath, useLabelActions } from "../labels/useLabelActions";
import { useCoarsePointer } from "../layout/useBreakpoint";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";
import { mailboxTexts } from "../labels/mailboxTexts";

/** Shows the move or label picker while one is open. */
export function MailboxPickerHost() {
  const picker = useUi((state) => state.picker);
  if (!picker) return null;
  return <MailboxPicker picker={picker} />;
}

type LabelState = "on" | "off" | "mixed";

/** Mailboxes that can be targets (Spam and Trash only for moving, via the role filter below). */
function isTarget(mailbox: Mailbox): boolean {
  return mailbox.assignable && mailbox.selectable;
}

/**
 * Picks a mailbox to move to, or toggles labels. A filter field drives the
 * list: type to filter, ↑/↓ to move, Enter to choose (move) or to apply
 * (labels). Label changes are applied together when the picker closes with
 * Enter or a click outside; Esc cancels. On phones it opens as a bottom sheet.
 * When nothing has the typed name, the last option creates that label
 * ("Work/2026" nests it): moving moves there, the label picker ticks it.
 */
function MailboxPicker({ picker }: { picker: PickerState }) {
  const setPicker = useUi((state) => state.setPicker);
  const route = useRoute();
  const actions = useMailActions();
  const t = useT();
  const capabilities = useAccountHandle(picker.accountId)?.provider
    .capabilities;
  const l = mailboxTexts(t, capabilities);
  const queryClient = useQueryClient();
  const { data: mailboxes = [] } = useMailboxList(picker.accountId);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [choices, setChoices] = useState<ReadonlyMap<MailboxId, boolean>>(
    new Map(),
  );
  const titleId = useId();
  const listId = useId();
  const labelsMode = picker.mode === "labels";
  const labels = useLabelActions();
  const canCreate = capabilities?.manageMailboxes ?? false;
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const close = () => {
    setPicker(null);
  };
  // On touch devices, focusing the filter would cover the sheet with the keyboard.
  const coarse = useCoarsePointer();

  const candidates = useMemo(
    () =>
      mailboxes.filter(
        (mailbox) =>
          isTarget(mailbox) &&
          (labelsMode
            ? mailbox.kind === "label" && mailbox.role === undefined
            : mailbox.id !== route?.mailboxId),
      ),
    [mailboxes, labelsMode, route?.mailboxId],
  );
  const visible = candidates
    .map((mailbox) => ({
      mailbox,
      path: mailboxPath(mailbox, mailboxes).join(" / "),
    }))
    .filter(({ path }) =>
      path.toLowerCase().includes(filter.trim().toLowerCase()),
    );

  // "Create label" when no mailbox has the typed path.
  const typed = splitPath(filter);
  const typedKey = typed.join("/").toLowerCase();
  const offerCreate =
    canCreate &&
    typed.length > 0 &&
    !mailboxes.some(
      (mailbox) =>
        mailboxPath(mailbox, mailboxes).join("/").toLowerCase() === typedKey,
    );
  const optionCount = visible.length + (offerCreate ? 1 : 0);
  const activeIndex = Math.max(0, Math.min(active, optionCount - 1));
  const createActive = offerCreate && activeIndex === visible.length;
  const highlighted = createActive ? undefined : visible[activeIndex]?.mailbox;

  // Current label state of the targets, for the tri-state checkboxes. A
  // conversation has a label when one of its messages has it.
  const initial = useMemo(() => {
    const units = picker.ids
      .map((id) =>
        cachedSummaries(
          queryClient,
          picker.accountId,
          picker.conversations === true
            ? threadMessageIds(queryClient, picker.accountId, [id])
            : [id],
        ),
      )
      .filter((unit) => unit.length > 0);
    const states = new Map<MailboxId, LabelState>();
    for (const mailbox of candidates) {
      const holders = units.filter((unit) =>
        unit.some((s) => s.mailboxIds.includes(mailbox.id)),
      ).length;
      states.set(
        mailbox.id,
        holders === 0 ? "off" : holders === units.length ? "on" : "mixed",
      );
    }
    return states;
  }, [
    queryClient,
    picker.accountId,
    picker.ids,
    picker.conversations,
    candidates,
  ]);

  const stateOf = (id: MailboxId): LabelState => {
    const choice = choices.get(id);
    if (choice !== undefined) return choice ? "on" : "off";
    return initial.get(id) ?? "off";
  };

  const toggle = (id: MailboxId) => {
    setChoices((current) => new Map(current).set(id, stateOf(id) !== "on"));
  };

  /** Applies label changes as one action, then closes. */
  const applyLabels = (extra?: MailboxId) => {
    const final = new Map(choices);
    if (extra !== undefined) final.set(extra, stateOf(extra) !== "on");
    const add: MailboxId[] = [];
    const remove: MailboxId[] = [];
    for (const [id, on] of final) {
      const before = initial.get(id) ?? "off";
      if (on && before !== "on") add.push(id);
      if (!on && before !== "off") remove.push(id);
    }
    if (add.length > 0 || remove.length > 0)
      actions.setLabels(add, remove, picker.ids);
    close();
  };

  const createLabel = () => {
    if (creating || !offerCreate) return;
    setCreating(true);
    setCreateError(undefined);
    labels.createPath(picker.accountId, typed).then(
      (mailbox) => {
        setCreating(false);
        if (labelsMode) {
          setChoices((current) => new Map(current).set(mailbox.id, true));
          setFilter(typed.join(" / "));
          setActive(0);
        } else {
          actions.moveTo(mailbox.id, picker.ids);
          close();
        }
      },
      (error: unknown) => {
        setCreating(false);
        setCreateError(errorMessage(error, t));
      },
    );
  };

  const choose = (mailbox: Mailbox) => {
    if (labelsMode) {
      toggle(mailbox.id);
      return;
    }
    actions.moveTo(mailbox.id, picker.ids);
    close();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(optionCount - 1, activeIndex + delta)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (createActive) {
        createLabel();
      } else if (!labelsMode) {
        if (highlighted) choose(highlighted);
      } else {
        // Quick path: type a label name and press Enter to toggle it.
        const quick =
          choices.size === 0 && filter.trim() !== ""
            ? highlighted?.id
            : undefined;
        applyLabels(quick);
      }
    } else if (
      event.key === " " &&
      labelsMode &&
      filter === "" &&
      highlighted
    ) {
      event.preventDefault();
      toggle(highlighted.id);
    }
  };

  const count = picker.ids.length;
  const title = labelsMode ? l.labels : l.moveTo;
  const optionId = (index: number) => `${listId}-${index}`;
  const highlightedIndex = optionCount === 0 ? -1 : activeIndex;

  return (
    <Sheet
      labelledBy={titleId}
      onEscape={close}
      onBackdrop={() => {
        if (labelsMode) applyLabels();
        else close();
      }}
      backdropLabel={labelsMode ? l.applyAndClose : t.common.close}
      focusContainer={coarse}
    >
      <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
        <h2 id={titleId} className="mb-2 text-sm font-semibold">
          {title}{" "}
          <span className="font-normal text-zinc-500">
            (
            {picker.conversations === true
              ? t.common.conversations(count)
              : t.common.messages(count)}
            )
          </span>
        </h2>
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            highlightedIndex === -1 ? undefined : optionId(highlightedIndex)
          }
          aria-label={labelsMode ? l.filterLabels : l.filterMailboxes}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setActive(0);
            setCreateError(undefined);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={labelsMode ? l.findLabel : l.findMailbox}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
        {createError ? (
          <p
            role="alert"
            className="mt-1.5 text-xs text-red-700 dark:text-red-400"
          >
            {createError}
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-zinc-500 pointer-coarse:hidden">
            {labelsMode ? l.labelsHint : l.moveHint}
          </p>
        )}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={title}
        aria-multiselectable={labelsMode || undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      >
        {optionCount === 0 && (
          <div
            role="presentation"
            className="px-3 py-4 text-center text-sm text-zinc-500"
          >
            {l.nothingMatches}
          </div>
        )}
        {visible.map(({ mailbox, path }, index) => {
          const state = stateOf(mailbox.id);
          return (
            // Clicks are fine on options; the combobox above handles the keyboard.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={mailbox.id}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={
                labelsMode ? state === "on" : index === highlightedIndex
              }
              aria-checked={
                labelsMode
                  ? state === "mixed"
                    ? "mixed"
                    : state === "on"
                  : undefined
              }
              onClick={() => {
                choose(mailbox);
              }}
              onMouseMove={() => {
                setActive(index);
              }}
              className={`flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-sm pointer-coarse:min-h-11 ${
                index === highlightedIndex
                  ? "bg-blue-50 dark:bg-blue-500/15"
                  : ""
              }`}
            >
              {labelsMode ? (
                <span
                  aria-hidden="true"
                  className={`grid size-4 shrink-0 place-items-center rounded border ${
                    state === "off"
                      ? "border-zinc-400 dark:border-zinc-500"
                      : "border-blue-600 bg-blue-600 text-white"
                  }`}
                >
                  {state === "on" && <Icon name="check" className="size-3" />}
                  {state === "mixed" && (
                    <span className="h-0.5 w-2 rounded bg-white" />
                  )}
                </span>
              ) : (
                <Icon
                  name={
                    mailbox.role === "inbox"
                      ? "inbox"
                      : mailbox.role === "trash"
                        ? "trash"
                        : mailbox.role === "junk"
                          ? "alert"
                          : "tag"
                  }
                  className="size-4 shrink-0 text-zinc-500"
                  style={
                    mailbox.color
                      ? { color: mailbox.color.background }
                      : undefined
                  }
                />
              )}
              <span className="min-w-0 flex-1 truncate">{path}</span>
            </div>
          );
        })}
        {offerCreate && (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            id={optionId(visible.length)}
            role="option"
            tabIndex={-1}
            aria-selected={createActive}
            aria-disabled={creating || undefined}
            onClick={createLabel}
            onMouseMove={() => {
              setActive(visible.length);
            }}
            className={`flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-sm text-blue-700 dark:text-blue-300 pointer-coarse:min-h-11 ${
              createActive ? "bg-blue-50 dark:bg-blue-500/15" : ""
            }`}
          >
            <Icon name="plus" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {creating ? l.creating : l.createLabel(typed.join(" / "))}
            </span>
          </div>
        )}
      </div>
      {labelsMode && (
        <div className="flex justify-end gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => {
              applyLabels();
            }}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
          >
            {l.apply}
          </button>
        </div>
      )}
    </Sheet>
  );
}
