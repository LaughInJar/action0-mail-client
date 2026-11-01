import { useState, type DragEvent, type KeyboardEvent } from "react";
import type { FocusViews } from "../../core/focus";
import { messageRef, type AccountId } from "../../core/ids";
import type { Focus, Mailbox } from "../../core/model";
import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import type { MailActions } from "../actions/useMailActions";

/** Props of {@link FocusTabs}. */
export interface FocusTabsProps {
  readonly accountId: AccountId;
  /** The account's Focused and Other (names in the interface language). */
  readonly views: FocusViews;
  /** The one shown. */
  readonly current: Mailbox;
  readonly actions: MailActions;
}

/**
 * Focused | Other above a split Inbox (Outlook's Focused Inbox): a tab
 * opens its side, ←/→ move between them, and mail dropped on the other
 * tab moves there (once). Other shows its unread count.
 */
export function FocusTabs({
  accountId,
  views,
  current,
  actions,
}: FocusTabsProps) {
  const t = useT();
  const router = useRouter();
  const store = useUiStore();
  const [dropOn, setDropOn] = useState<Focus | null>(null);
  const tabs = [views.focused, views.other];

  const open = (tab: Mailbox) => {
    if (tab.id !== current.id)
      router.navigate({ accountId, mailboxId: tab.id });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const other = tabs.find((tab) => tab.id !== current.id);
    if (!other) return;
    open(other);
    document.getElementById(tabId(other))?.focus();
  };
  /** The dragged rows, if they may go to `focus` (this account's, from the other tab). */
  const droppable = (focus: Focus) => {
    const keys = store.getState().dragging?.keys ?? [];
    return focus !== current.standard &&
      keys.length > 0 &&
      keys.every((key) => messageRef(key).accountId === accountId)
      ? keys
      : undefined;
  };

  return (
    <div
      role="tablist"
      aria-label={t.focus.tabs}
      className="flex border-b border-zinc-200 px-2 dark:border-zinc-800"
    >
      {tabs.map((tab) => {
        const focus: Focus = tab.standard === "other" ? "other" : "focused";
        const selected = tab.id === current.id;
        const unread = focus === "other" ? (tab.counts?.unread ?? 0) : 0;
        const onDragOver = (event: DragEvent) => {
          if (!droppable(focus)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropOn(focus);
        };
        const onDrop = (event: DragEvent) => {
          const keys = droppable(focus);
          setDropOn(null);
          if (!keys) return;
          event.preventDefault();
          store.getState().setDragging(null);
          actions.setFocus(focus, keys);
        };
        return (
          <button
            key={tab.id}
            id={tabId(tab)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={
              unread > 0 ? `${tab.name}, ${t.focus.unread(unread)}` : undefined
            }
            tabIndex={selected ? 0 : -1}
            onKeyDown={onKeyDown}
            onClick={() => {
              open(tab);
            }}
            onDragOver={onDragOver}
            onDragLeave={() => {
              setDropOn(null);
            }}
            onDrop={onDrop}
            className={`-mb-px flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium pointer-coarse:min-h-11 ${
              selected
                ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            } ${dropOn === focus ? "rounded-t bg-blue-50 ring-2 ring-blue-500 dark:bg-blue-500/20" : ""}`}
          >
            {tab.name}
            {unread > 0 && (
              <span className="rounded-full bg-zinc-200 px-1.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const tabId = (tab: Mailbox) => `focus-tab-${tab.id}`;
