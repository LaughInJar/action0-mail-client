import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import type { AccountId, MessageId } from "../../core/ids";
import type { Mailbox, MessageSummary } from "../../core/model";
import { useUi, useUiStore } from "../../state/context";
import { useCoarsePointer } from "../layout/useBreakpoint";
import { MessageRow } from "./MessageRow";
import { useLongPress } from "./useLongPress";

/** The row of a message (ids are opaque, so no CSS selector built from them). */
function rowOf(list: HTMLElement, id: MessageId): HTMLElement | undefined {
  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-message-id]"),
  ).find((row) => row.dataset.messageId === id);
}

/** DOM id of the listbox (focused after a search). */
export const MESSAGE_LIST_ID = "message-list";

/** DOM id of the row at `index` (for `aria-activedescendant`). */
const rowDomId = (index: number) => `message-row-${index}`;

/** Props of {@link MessageList}. */
export interface MessageListProps {
  readonly accountId: AccountId;
  /** Rows can be dragged onto the tree (not inside Trash/Spam). */
  readonly allowDrag: boolean;
  readonly items: readonly MessageSummary[];
  readonly mailbox: Mailbox | undefined;
  /** Accessible name; defaults to "Messages in <mailbox>". */
  readonly label?: string;
  /** Identifies the list (see `listKeyOf`), exposed as `data-list-key`. */
  readonly listKey?: string;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
  /** Shows a message (plain click or tap). */
  readonly onOpen: (id: MessageId) => void;
  /** Toggles the star of one message (click on a row's star). Omit if starring isn't supported. */
  readonly onToggleStar?: (id: MessageId) => void;
}

/** A small badge as drag image ("3 messages"); removed right after the drag starts. */
function dragBadge(text: string): HTMLElement {
  const badge = document.createElement("div");
  badge.textContent = text;
  badge.style.cssText =
    "position:fixed;top:-100px;left:-100px;padding:4px 10px;border-radius:9999px;" +
    "background:#2563eb;color:#fff;font:600 13px system-ui,sans-serif;white-space:nowrap";
  document.body.append(badge);
  setTimeout(() => {
    badge.remove();
  }, 0);
  return badge;
}

/**
 * The message list as a multi-select listbox. Focus stays on the listbox;
 * the focused row is announced through `aria-activedescendant`.
 *
 * - Click/tap: show the message (and drop any multi-selection).
 * - Ctrl/Cmd-click: toggle. Shift-click: select a range.
 * - Long press (touch): start selecting; further taps toggle.
 * - Drag (mouse): rows are drag sources for the mailbox tree. Dragging a
 *   selected row drags the whole selection.
 */
export function MessageList({
  accountId,
  allowDrag,
  items,
  mailbox,
  label,
  listKey,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onOpen,
  onToggleStar,
}: MessageListProps) {
  const coarse = useCoarsePointer();
  const store = useUiStore();
  const focusedId = useUi((state) => state.focusedId);
  const compact = useUi((state) => state.settings.density === "compact");
  const selectedIds = useUi((state) => state.selectedIds);
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const pointerType = useRef("mouse");
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // New mail arriving above what you see: keep the visible rows in place
  // (by hand: Safari has no scroll anchoring) and offer a jump to the top.
  const anchor = useRef<{ id: MessageId; offset: number } | null>(null);
  const [anchorId, setAnchorId] = useState<MessageId | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<MessageId>>(() => new Set(ids));
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollTop <= 0) {
      anchor.current = null;
      setAnchorId(null);
      setSeen(new Set(ids));
      return;
    }
    const first = Array.from(
      list.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((row) => row.offsetTop + row.offsetHeight > list.scrollTop);
    const id = first?.dataset.messageId as MessageId | undefined;
    anchor.current =
      first && id !== undefined
        ? { id, offset: first.offsetTop - list.scrollTop }
        : null;
    setAnchorId(id ?? null);
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    const kept = anchor.current;
    if (!list || !kept || list.scrollTop <= 0) return;
    const row = rowOf(list, kept.id);
    if (!row) return;
    const shift = row.offsetTop - list.scrollTop - kept.offset;
    if (shift !== 0) list.scrollTop += shift;
  }, [ids]);
  const anchorIndex = anchorId === null ? -1 : ids.indexOf(anchorId);
  const newAbove =
    anchorIndex > 0
      ? ids.slice(0, anchorIndex).filter((id) => !seen.has(id)).length
      : 0;

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
    if (onToggleStar && (event.target as HTMLElement).closest("[data-star]")) {
      onToggleStar(id);
      return;
    }
    const state = store.getState();
    if (event.shiftKey) state.selectRange(ids, id);
    else if (event.ctrlKey || event.metaKey) state.toggle(id);
    else if (state.selectedIds.size > 0 && pointerType.current !== "mouse")
      state.toggle(id);
    else onOpen(id);
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const id = idFromTarget(event.target);
    if (id === undefined) return;
    const state = store.getState();
    const dragged = state.selectedIds.has(id)
      ? ids.filter((candidate) => state.selectedIds.has(candidate))
      : [id];
    state.setDragging({ accountId, ids: dragged });
    const label =
      dragged.length === 1 ? "1 message" : `${dragged.length} messages`;
    event.dataTransfer.effectAllowed = "copyMove";
    // Firefox only starts a drag with some data set.
    event.dataTransfer.setData("text/plain", label);
    event.dataTransfer.setDragImage(dragBadge(label), -12, -12);
  };

  const focusedIndex = focusedId === null ? -1 : ids.indexOf(focusedId);

  // Follow the cursor when it moves (not when mail arriving above shifts it).
  useEffect(() => {
    if (focusedId === null) return;
    const list = listRef.current;
    if (list) rowOf(list, focusedId)?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

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
    <div className="relative h-full">
      {newAbove > 0 && (
        <button
          type="button"
          onClick={() => {
            if (listRef.current) listRef.current.scrollTop = 0;
            anchor.current = null;
            setAnchorId(null);
            setSeen(new Set(ids));
            store.getState().focusAt(ids, 0);
          }}
          className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-sm font-medium text-white shadow-lg hover:bg-blue-700 pointer-coarse:min-h-11"
        >
          ↑{" "}
          {newAbove === 1
            ? "1 new message"
            : `${String(newAbove)} new messages`}
        </button>
      )}
      <div
        ref={listRef}
        id={MESSAGE_LIST_ID}
        data-list-key={listKey}
        role="listbox"
        data-density={compact ? "compact" : "comfortable"}
        aria-label={
          label ?? (mailbox ? `Messages in ${mailbox.name}` : "Messages")
        }
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
        onDragStart={onDragStart}
        onDragEnd={() => {
          store.getState().setDragging(null);
        }}
        onScroll={onScroll}
        className="relative h-full overflow-y-auto overscroll-contain [overflow-anchor:none] focus:outline-none"
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
              draggable={allowDrag && !coarse}
              starrable={onToggleStar !== undefined}
              compact={compact}
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
    </div>
  );
}
