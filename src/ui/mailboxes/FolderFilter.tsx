import { useRef, type KeyboardEvent } from "react";
import { asAccountId, asMailboxId } from "../../core/ids";
import { useUi, useUiStore } from "../../state/context";
import { focusWhenReady } from "../common/focusWhenReady";
import { Icon } from "../common/Icon";
import { MESSAGE_LIST_ID } from "../messages/MessageList";
import { listKeyOf } from "../messages/useCurrentList";

/** DOM id of the folder filter field (focused by `g f`). */
export const FOLDER_FILTER_ID = "folder-filter";

/**
 * Filters the mailbox tree below it by name. ↓ moves into the matches,
 * Enter opens the first match and moves to its messages, Esc clears the
 * filter (or, when empty, goes back to the message list or closes the
 * drawer).
 */
export function FolderFilter() {
  const text = useUi((state) => state.folderFilter);
  const setText = useUi((state) => state.setFolderFilter);
  const store = useUiStore();
  const inputRef = useRef<HTMLInputElement>(null);

  /** Tree items of this sidebar, matches only while filtering. */
  const items = (selector: string) =>
    Array.from(
      inputRef.current
        ?.closest("nav")
        ?.querySelectorAll<HTMLElement>(`[role="treeitem"]${selector}`) ?? [],
    );

  // Capture phase: runs before the drawer's Escape handler, so the first
  // Escape only clears the filter.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLInputElement>) => {
    const filtering = text.trim() !== "";
    switch (event.key) {
      case "ArrowDown":
        (filtering ? items('[data-match="true"]') : items(""))[0]?.focus();
        break;
      case "Enter": {
        if (!filtering) return;
        const match = items('[data-match="true"][data-selectable="true"]')[0];
        const { accountId, mailboxId } = match?.dataset ?? {};
        if (!match || accountId === undefined || mailboxId === undefined) break;
        match.click();
        // Continue in the folder's messages (once they're shown), so j/k work.
        const key = listKeyOf(
          {
            accountId: asAccountId(accountId),
            mailboxId: asMailboxId(mailboxId),
          },
          store.getState().listOrder,
          store.getState().settings.conversations,
        );
        focusWhenReady(MESSAGE_LIST_ID, {
          accept: (element) => element.dataset.listKey === key,
        });
        break;
      }
      case "Escape":
        if (filtering) {
          setText("");
          event.stopPropagation();
        } else if (inputRef.current?.closest('[role="dialog"]')) {
          return; // The drawer closes.
        } else {
          focusWhenReady(MESSAGE_LIST_ID);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="relative px-2 pb-1">
      <Icon
        name="search"
        className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-zinc-400"
      />
      <input
        ref={inputRef}
        id={FOLDER_FILTER_ID}
        data-initial-focus=""
        type="search"
        aria-label="Filter folders"
        placeholder="Filter folders"
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDownCapture={onKeyDownCapture}
        className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pr-8 pl-8 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear filter"
          title="Clear filter"
          onClick={() => {
            setText("");
            inputRef.current?.focus();
          }}
          className="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 pointer-coarse:size-10"
        >
          <Icon name="x" className="size-3.5" />
        </button>
      )}
    </div>
  );
}
