import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import type { MessageId } from "../../core/ids";
import type { Mailbox, MessageSummary } from "../../core/model";
import { useUi, useUiStore } from "../../state/context";
import { MessageRow } from "./MessageRow";
import { useLongPress } from "./useLongPress";

/** DOM id of the row at `index` (for `aria-activedescendant`). */
const rowDomId = (index: number) => `message-row-${index}`;

/** Props of {@link MessageList}. */
export interface MessageListProps {
  readonly items: readonly MessageSummary[];
  readonly mailbox: Mailbox | undefined;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
  /** Shows a message (plain click or tap). */
  readonly onOpen: (id: MessageId) => void;
}

/**
 * The message list as a multi-select listbox. Focus stays on the listbox;
 * the focused row is announced through `aria-activedescendant`.
 *
 * - Click/tap: show the message (and drop any multi-selection).
 * - Ctrl/Cmd-click: toggle. Shift-click: select a range.
 * - Long press (touch): start selecting; further taps toggle.
 */
export function MessageList({
  items,
  mailbox,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onOpen,
}: MessageListProps) {
  const store = useUiStore();
  const focusedId = useUi((state) => state.focusedId);
  const selectedIds = useUi((state) => state.selectedIds);
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const pointerType = useRef("mouse");
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const idFromTarget = (target: EventTarget | null): MessageId | undefined => {
    const row = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-message-id]",
    );
    return row?.dataset.messageId as MessageId | undefined;
  };

  const longPress = useLongPress((target) => {
    const id = idFromTarget(target);
    if (id !== undefined) store.getState().toggle(id);
  });

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (longPress.consumeClick()) return;
    const id = idFromTarget(event.target);
    if (id === undefined) return;
    const state = store.getState();
    if (event.shiftKey) state.selectRange(ids, id);
    else if (event.ctrlKey || event.metaKey) state.toggle(id);
    else if (state.selectedIds.size > 0 && pointerType.current !== "mouse")
      state.toggle(id);
    else onOpen(id);
  };

  const focusedIndex = focusedId === null ? -1 : ids.indexOf(focusedId);

  useEffect(() => {
    if (focusedIndex === -1) return;
    document
      .getElementById(rowDomId(focusedIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  // Load the next page when the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      !hasNextPage ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          !isFetchingNextPage
        )
          fetchNextPage();
      },
      { root: listRef.current, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const selectionMode = selectedIds.size > 0;
  const showRecipients = mailbox?.role === "sent" || mailbox?.role === "drafts";

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={mailbox ? `Messages in ${mailbox.name}` : "Messages"}
      aria-multiselectable="true"
      aria-activedescendant={
        focusedIndex === -1 ? undefined : rowDomId(focusedIndex)
      }
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        // Enter opens like a click; all other keys go to the global keymap.
        const focused = store.getState().focusedId;
        if (event.key === "Enter" && focused !== null) {
          event.preventDefault();
          onOpen(focused);
        }
      }}
      onPointerDown={(event) => {
        pointerType.current = event.pointerType;
        longPress.onPointerDown(event);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={longPress.onContextMenu}
      className="h-full overflow-y-auto overscroll-contain focus:outline-none"
    >
      {items.map((summary, index) => {
        const focused = summary.id === focusedId;
        return (
          <MessageRow
            key={summary.id}
            domId={rowDomId(index)}
            summary={summary}
            focused={focused}
            selected={selectionMode ? selectedIds.has(summary.id) : focused}
            selectionMode={selectionMode}
            showRecipients={showRecipients}
          />
        );
      })}
      {hasNextPage && (
        <div ref={sentinelRef} className="flex justify-center p-3">
          <button
            type="button"
            disabled={isFetchingNextPage}
            onClick={(event) => {
              event.stopPropagation();
              fetchNextPage();
            }}
            className="rounded-md px-3 py-1.5 text-sm text-blue-700 hover:bg-zinc-100 disabled:text-zinc-400 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
