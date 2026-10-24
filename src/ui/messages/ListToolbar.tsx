import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { Mailbox } from "../../core/model";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import { listRoute, type Route } from "../../state/router";
import { focusWhenReady } from "../common/focusWhenReady";
import { Icon } from "../common/Icon";
import { MESSAGE_LIST_ID } from "./MessageList";
import { listKeyOf } from "./useCurrentList";
import { useT } from "../../i18n/context";

/** DOM id of the mail search field (focused by `/`). */
export const SEARCH_FIELD_ID = "mail-search";

/** Search runs once typing pauses for this long. */
export const SEARCH_DELAY_MS = 400;

/** Props of {@link ListToolbar}. */
export interface ListToolbarProps {
  /** The mailbox in the URL (where a search starts). */
  readonly mailbox: Mailbox | undefined;
  /** The mailbox that "Everywhere" searches; undefined if the account has none. */
  readonly everywhere: Mailbox | undefined;
  /** All inboxes: searches every account's Inbox, or every whole account. */
  readonly unified: boolean;
}

/**
 * Below the list header: the mail search field and the sort order, plus the
 * "search in" switch while a search is shown.
 */
export function ListToolbar({
  mailbox,
  everywhere,
  unified,
}: ListToolbarProps) {
  const t = useT();
  const route = useRoute();
  const router = useRouter();
  const search = route?.search;
  const order = useUi((state) => state.listOrder);
  const setListOrder = useUi((state) => state.setListOrder);
  const canSwitch =
    search !== undefined &&
    (unified ||
      (everywhere !== undefined &&
        mailbox !== undefined &&
        mailbox.id !== everywhere.id));
  const here = unified ? t.list.allInboxes : mailbox?.name;

  const searchIn = (all: boolean) => {
    const current = router.getRoute();
    if (!current?.search || current.search.everywhere === all) return;
    router.navigate({
      accountId: current.accountId,
      mailboxId: current.mailboxId,
      ...(current.unified ? { unified: true } : {}),
      search: { text: current.search.text, everywhere: all },
    });
  };

  return (
    <div className="border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <div className="flex items-center gap-1">
        <SearchField
          placeholder={
            search?.everywhere || here === undefined
              ? t.list.searchAll
              : t.list.searchIn(here)
          }
        />
        <button
          type="button"
          title={t.list.changeOrder}
          onClick={() => {
            // Start at the top of the re-sorted list, not at the open message.
            const current = router.getRoute();
            if (current) router.navigate(listRoute(current), { replace: true });
            setListOrder(order === "newest" ? "oldest" : "newest");
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          <Icon name="sort" className="size-3.5" />
          {order === "newest" ? t.list.newestFirst : t.list.oldestFirst}
        </button>
      </div>
      {canSwitch && (
        <div
          role="group"
          aria-label={t.list.searchScope}
          className="mt-1.5 flex items-center gap-1 text-xs"
        >
          <span className="px-1 text-zinc-500">{t.list.scopeIn}</span>
          <ScopeButton
            pressed={!search.everywhere}
            onClick={() => {
              searchIn(false);
            }}
          >
            {here ?? ""}
          </ScopeButton>
          <ScopeButton
            pressed={search.everywhere}
            onClick={() => {
              searchIn(true);
            }}
          >
            {t.list.everywhere}
          </ScopeButton>
        </div>
      )}
    </div>
  );
}

function ScopeButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`max-w-40 truncate rounded-full border px-2.5 py-0.5 font-medium pointer-coarse:min-h-11 pointer-coarse:px-3.5 ${
        pressed
          ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
          : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The mail search. It searches as you type (after {@link SEARCH_DELAY_MS})
 * and keeps the search in the URL: the first search adds a history entry,
 * refining it replaces that entry, and clearing it adds one again.
 *
 * Keys: Enter searches right away and moves to the results, ↓ moves to the
 * results, Esc clears the search (or, when empty, moves to the list).
 */
function SearchField({ placeholder }: { placeholder: string }) {
  const t = useT();
  const route = useRoute();
  const router = useRouter();
  const store = useUiStore();
  const routeText = route?.search?.text.trim() ?? "";
  // All inboxes stays one list while the account in context changes.
  const listId = JSON.stringify(
    route?.unified
      ? ["all"]
      : [route?.accountId ?? null, route?.mailboxId ?? null],
  );
  const [text, setText] = useState(routeText);
  // What the field last followed, and what it last wrote to the URL itself.
  const [shown, setShown] = useState({ listId, routeText });
  const [committed, setCommitted] = useState(routeText);
  if (shown.listId !== listId || shown.routeText !== routeText) {
    // The URL changed: follow it, unless it's our own (older) search while
    // the user keeps typing.
    setShown({ listId, routeText });
    if (shown.listId !== listId || routeText !== committed) {
      setText(routeText);
      setCommitted(routeText);
    }
  }

  /** Puts the search into the URL; returns the route of its list. */
  const commit = useCallback(
    (value: string): Route => {
      const current = router.getRoute();
      if (!current) return null;
      const next = value.trim();
      setCommitted(next);
      if (next === (current.search?.text.trim() ?? "")) return current;
      const list = {
        accountId: current.accountId,
        mailboxId: current.mailboxId,
        ...(current.unified ? { unified: true as const } : {}),
      };
      const searched = next
        ? {
            ...list,
            search: {
              text: next,
              everywhere: current.search?.everywhere ?? false,
            },
          }
        : list;
      // Refining a search replaces its history entry.
      router.navigate(searched, { replace: next !== "" && !!current.search });
      return searched;
    },
    [router],
  );

  /** Moves focus to the list, once it shows the results of `route`. */
  const focusResults = (target: Route) => {
    const { listOrder, settings } = store.getState();
    const key = listKeyOf(target, listOrder, settings.conversations);
    focusWhenReady(MESSAGE_LIST_ID, {
      accept: (element) => element.dataset.listKey === key,
    });
  };

  // Search as you type, once typing pauses.
  useEffect(() => {
    if (text.trim() === committed) return;
    const timer = setTimeout(() => {
      commit(text);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, committed, commit]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "Enter":
      case "ArrowDown":
        focusResults(commit(text));
        break;
      case "Escape":
        if (text) {
          setText("");
          commit("");
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
    <div className="relative min-w-0 flex-1">
      <Icon
        name="search"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400"
      />
      <input
        id={SEARCH_FIELD_ID}
        type="search"
        aria-label={t.list.searchMail}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pr-8 pl-8 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text && (
        <button
          type="button"
          aria-label={t.list.clearSearch}
          title={t.list.clearSearch}
          onClick={() => {
            setText("");
            commit("");
            document.getElementById(SEARCH_FIELD_ID)?.focus();
          }}
          className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:size-10"
        >
          <Icon name="x" className="size-3.5" />
        </button>
      )}
    </div>
  );
}
