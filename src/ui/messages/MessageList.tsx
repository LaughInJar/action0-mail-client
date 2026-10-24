import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId, MessageKey } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import type { ListRow } from "../../data/listRows";
import { useSendersOf } from "../../data/senders";
import type { ListSource } from "../../data/unified";
import { useUi, useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import {
  atPointer,
  belowElement,
  isMenuKey,
  wantsAppMenu,
} from "../common/menuPosition";
import { useAccountColors } from "../accounts/accountColors";
import { useCoarsePointer } from "../layout/useBreakpoint";
import { MessageRow } from "./MessageRow";
import { rowView, type RowContext } from "./rowView";
import { useLongPress } from "./useLongPress";
import { useT } from "../../i18n/context";

/** The row with a key (keys hold opaque ids, so no CSS selector built from them). */
function rowOf(list: HTMLElement, key: MessageKey): HTMLElement | undefined {
  return Array.from(list.querySelectorAll<HTMLElement>("[data-row-key]")).find(
    (row) => row.dataset.rowKey === key,
  );
}

/** DOM id of the listbox (focused after a search). */
export const MESSAGE_LIST_ID = "message-list";

/** DOM id of the row at `index` (for `aria-activedescendant`). */
const rowDomId = (index: number) => `message-row-${index}`;

/** Props of {@link MessageList}. */
export interface MessageListProps {
  /** Rows can be dragged onto the tree (not inside Trash/Spam). */
  readonly allowDrag: boolean;
  /** Messages, or conversations (All inboxes: of several accounts). */
  readonly rows: readonly ListRow[];
  /** Each account in the list: what's listed of it (mailbox, Spam and Trash, Drafts). */
  readonly sources: ReadonlyMap<AccountId, ListSource>;
  /** All inboxes: rows show their account. */
  readonly showAccounts: boolean;
  /** The mailbox in the default accessible name. */
  readonly mailbox: Mailbox | undefined;
  /** Accessible name; defaults to "Messages in <mailbox>". */
  readonly label?: string;
  /** Identifies the list (see `listKeyOf`), exposed as `data-list-key`. */
  readonly listKey?: string;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
  /** Shows a message (plain click or tap). */
  readonly onOpen: (key: MessageKey) => void;
  /**
   * Enter opens the row too (phones, Drafts); elsewhere the row is open
   * already and Enter goes to the app's shortcuts (e.g. a conversation).
   */
  readonly enterOpens: boolean;
  /** Toggles the star of one message (click on a row's star). Omit if starring isn't supported. */
  readonly onToggleStar?: (key: MessageKey) => void;
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
  allowDrag,
  rows,
  sources,
  showAccounts,
  mailbox,
  label,
  listKey,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onOpen,
  enterOpens,
  onToggleStar,
}: MessageListProps) {
  const coarse = useCoarsePointer();
  const store = useUiStore();
  const focusedId = useUi((state) => state.focusedId);
  const compact = useUi((state) => state.settings.density === "compact");
  const t = useT();
  const selectedIds = useUi((state) => state.selectedIds);
  const ids = useMemo(() => rows.map((row) => row.key), [rows]);
  const accounts = useAccounts();
  const accountIds = useMemo(() => [...sources.keys()], [sources]);
  const senders = useSendersOf(accountIds);
  const colors = useAccountColors();
  const views = useMemo(() => {
    const contexts = new Map(
      [...sources].map(([accountId, source]) => {
        const email = accounts.find((h) => h.account.id === accountId)?.account
          .email;
        // "me" in a conversation's senders: the account's addresses.
        const mine = new Set(
          [
            email ?? "",
            ...(senders.get(accountId) ?? []).map((sender) => sender.address),
          ].map((address) => address.toLowerCase()),
        );
        const role = source.scope?.role;
        const context: RowContext = {
          mailbox: source.scope,
          isolating: source.isolating,
          mine,
          showRecipients: role === "sent" || role === "drafts",
          drafts: source.mailboxes?.find((m) => m.role === "drafts")?.id,
          t,
        };
        return [accountId, { context, email }] as const;
      }),
    );
    return rows.flatMap((row) => {
      const found = contexts.get(row.accountId);
      if (!found) return [];
      const color = colors.get(row.accountId);
      return [
        rowView(
          row,
          found.context,
          showAccounts && found.email !== undefined && color !== undefined
            ? { email: found.email, color }
            : undefined,
        ),
      ];
    });
  }, [rows, sources, accounts, senders, colors, showAccounts, t]);
  const pointerType = useRef("mouse");
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // New mail arriving above what you see: keep the visible rows in place
  // (by hand: Safari has no scroll anchoring) and offer a jump to the top.
  const anchor = useRef<{ id: MessageKey; offset: number } | null>(null);
  const [anchorId, setAnchorId] = useState<MessageKey | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<MessageKey>>(() => new Set(ids));
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
      list.querySelectorAll<HTMLElement>("[data-row-key]"),
    ).find((row) => row.offsetTop + row.offsetHeight > list.scrollTop);
    const id = first?.dataset.rowKey as MessageKey | undefined;
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

  const idFromTarget = (target: EventTarget | null): MessageKey | undefined => {
    const row = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-row-key]",
    );
    return row?.dataset.rowKey as MessageKey | undefined;
  };

  /** The menu of a row: the selection if the row is part of it, else the row. */
  const openMenu = (key: MessageKey, at: MenuPosition) => {
    const { selectedIds: selection, setContextMenu } = store.getState();
    const keys = selection.has(key)
      ? ids.filter((candidate) => selection.has(candidate))
      : [key];
    setContextMenu({ kind: "rows", keys, at });
  };

  // A long press opens the menu (its first entry starts selecting).
  const longPress = useLongPress((target, at) => {
    const id = idFromTarget(target);
    if (id !== undefined) openMenu(id, atPointer(at));
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
    state.setDragging({ keys: dragged });
    const label = t.common.messages(dragged.length);
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
          ↑ {t.list.newAbove(newAbove)}
        </button>
      )}
      <div
        ref={listRef}
        id={MESSAGE_LIST_ID}
        data-list-key={listKey}
        role="listbox"
        data-density={compact ? "compact" : "comfortable"}
        aria-label={
          label ?? (mailbox ? t.list.messagesIn(mailbox.name) : t.list.messages)
        }
        aria-multiselectable="true"
        aria-activedescendant={
          focusedIndex === -1 ? undefined : rowDomId(focusedIndex)
        }
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          const focused = store.getState().focusedId;
          if (isMenuKey(event) && focused !== null) {
            event.preventDefault();
            const row = listRef.current && rowOf(listRef.current, focused);
            if (row) openMenu(focused, belowElement(row));
            return;
          }
          // Enter opens like a click; all other keys go to the global keymap.
          if (event.key === "Enter" && enterOpens && focused !== null) {
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
        onContextMenu={(event) => {
          const id = idFromTarget(event.target);
          // Touch: the long press opens the menu. Shift keeps the browser's.
          if (
            id === undefined ||
            pointerType.current !== "mouse" ||
            !wantsAppMenu(event)
          ) {
            longPress.onContextMenu(event);
            return;
          }
          event.preventDefault();
          openMenu(id, atPointer(event));
        }}
        onDragStart={onDragStart}
        onDragEnd={() => {
          store.getState().setDragging(null);
        }}
        onScroll={onScroll}
        className="relative h-full overflow-y-auto overscroll-contain [overflow-anchor:none] focus:outline-none"
      >
        {views.map((view, index) => {
          const focused = view.key === focusedId;
          return (
            <MessageRow
              key={view.key}
              domId={rowDomId(index)}
              view={view}
              focused={focused}
              selected={selectionMode ? selectedIds.has(view.key) : focused}
              selectionMode={selectionMode}
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
              {isFetchingNextPage ? t.common.loading : t.list.loadMore}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
