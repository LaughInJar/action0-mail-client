import { useEffect, useMemo } from "react";
import type { MessageId } from "../../core/ids";
import type { ListRow } from "../../data/listRows";
import type { Command } from "../../keyboard/registry";
import { useCommands } from "../../keyboard/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { listRoute, type HashRouter } from "../../state/router";
import type { UiStore } from "../../state/uiStore";
import type { Breakpoint } from "../layout/useBreakpoint";
import { listKeyOf, useCurrentList } from "./useCurrentList";
import { useT, type I18n } from "../../i18n/context";

const EMPTY: readonly ListRow[] = [];

/**
 * Owns the message-list behavior that must work regardless of which panes
 * are visible:
 * - keeps focus/selection (store) and the URL (router) in sync,
 * - focuses the newest message when a list opens,
 * - loads more messages when the cursor nears the end,
 * - registers the list's keyboard commands.
 */
export function useListController(breakpoint: Breakpoint): void {
  const { route, list, rows, listKey } = useCurrentList();
  const t = useT();
  const router = useRouter();
  const store = useUiStore();
  const items = rows ?? EMPTY;
  const ids = useMemo(() => items.map((item) => item.id), [items]);

  // URL → store: switching lists resets the selection; a message in the URL gets focus.
  useEffect(() => {
    if (!route || listKey === null) return;
    const state = store.getState();
    if (state.listKey !== listKey)
      state.enterList(listKey, route.messageId ?? null);
    else if (
      route.messageId !== undefined &&
      route.messageId !== state.focusedId
    ) {
      state.focusOnly(route.messageId);
    }
  }, [route, listKey, store]);

  // Store → URL (wide and medium): the focused message is the open one.
  useEffect(() => {
    if (breakpoint === "narrow") return;
    const sync = () => {
      const state = store.getState();
      const current = router.getRoute();
      if (
        !current ||
        state.listKey !==
          listKeyOf(current, state.listOrder, state.settings.conversations)
      )
        return;
      // Nothing open any more ("back to the list" after archiving).
      if (state.focusedId === null) {
        if (current.messageId !== undefined && state.anchorId !== null)
          router.navigate(listRoute(current), { replace: true });
        return;
      }
      if (current.messageId === state.focusedId) return;
      router.navigate(
        { ...current, messageId: state.focusedId },
        { replace: true },
      );
    };
    sync();
    return store.subscribe((state, previous) => {
      if (state.focusedId !== previous.focusedId) sync();
    });
  }, [breakpoint, router, store]);

  // Focus the newest message once the list has loaded (not after "back to
  // the list", which leaves an anchor to continue from).
  useEffect(() => {
    const state = store.getState();
    if (
      state.listKey === listKey &&
      state.focusedId === null &&
      state.anchorId === null &&
      ids.length > 0
    ) {
      state.focusAt(ids, 0);
    }
  }, [ids, listKey, store]);

  // Fetch the next page before the cursor reaches the end.
  const focusedIndex = useUi((state) =>
    state.focusedId === null ? -1 : ids.indexOf(state.focusedId),
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (
      focusedIndex >= 0 &&
      focusedIndex >= ids.length - 5 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [
    focusedIndex,
    ids.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  const commands = useMemo(
    () => createListCommands({ breakpoint, ids, router, store, t }),
    [breakpoint, ids, router, store, t],
  );
  useCommands(commands);
}

interface ListCommandContext {
  readonly breakpoint: Breakpoint;
  readonly ids: readonly MessageId[];
  readonly router: HashRouter;
  readonly store: UiStore;
  readonly t: I18n;
}

function createListCommands({
  breakpoint,
  ids,
  router,
  store,
  t,
}: ListCommandContext): Command[] {
  const group = "list";
  const hasItems = () => ids.length > 0;
  const readerOpenOnPhone = () =>
    breakpoint === "narrow" && router.getRoute()?.messageId !== undefined;

  /** On phones with the reader open, moving the cursor shows the next message. */
  const followFocus = () => {
    const current = router.getRoute();
    const focusedId = store.getState().focusedId;
    if (readerOpenOnPhone() && current && focusedId !== null) {
      router.navigate({ ...current, messageId: focusedId }, { replace: true });
    }
  };

  return [
    {
      id: "list.next",
      group,
      description: t.shortcuts.nextMessage,
      keys: ["j", "ArrowDown"],
      when: hasItems,
      run: () => {
        store.getState().moveFocus(ids, 1);
        followFocus();
      },
    },
    {
      id: "list.previous",
      group,
      description: t.shortcuts.previousMessage,
      keys: ["k", "ArrowUp"],
      when: hasItems,
      run: () => {
        store.getState().moveFocus(ids, -1);
        followFocus();
      },
    },
    {
      id: "list.extend-next",
      group,
      description: t.shortcuts.extendDown,
      keys: ["shift+j", "shift+ArrowDown"],
      when: hasItems,
      run: () => {
        store.getState().extendFocus(ids, 1);
      },
    },
    {
      id: "list.extend-previous",
      group,
      description: t.shortcuts.extendUp,
      keys: ["shift+k", "shift+ArrowUp"],
      when: hasItems,
      run: () => {
        store.getState().extendFocus(ids, -1);
      },
    },
    {
      id: "list.toggle",
      group,
      description: t.shortcuts.toggleSelection,
      keys: ["x"],
      when: () => store.getState().focusedId !== null,
      run: () => {
        const { focusedId, toggle } = store.getState();
        if (focusedId !== null) toggle(focusedId);
      },
    },
    {
      id: "list.first",
      group,
      description: t.shortcuts.firstMessage,
      keys: ["Home"],
      when: hasItems,
      run: () => {
        store.getState().focusAt(ids, 0);
        followFocus();
      },
    },
    {
      id: "list.last",
      group,
      description: t.shortcuts.lastMessage,
      keys: ["End"],
      when: hasItems,
      run: () => {
        store.getState().focusAt(ids, -1);
        followFocus();
      },
    },
    {
      id: "list.clear-selection",
      group,
      description: t.shortcuts.clearSelection,
      keys: ["Escape"],
      when: () => store.getState().selectedIds.size > 0,
      run: () => {
        store.getState().clearSelection();
      },
    },
    {
      id: "list.open",
      group,
      description: t.shortcuts.openMessage,
      keys: ["Enter", "o"],
      when: () =>
        breakpoint === "narrow" &&
        !readerOpenOnPhone() &&
        store.getState().focusedId !== null,
      run: () => {
        const current = router.getRoute();
        const focusedId = store.getState().focusedId;
        if (current && focusedId !== null)
          router.navigate({ ...current, messageId: focusedId });
      },
    },
    {
      id: "reader.close",
      group,
      description: t.shortcuts.backToList,
      keys: ["Escape", "u"],
      when: () =>
        readerOpenOnPhone() && store.getState().selectedIds.size === 0,
      run: () => {
        const current = router.getRoute();
        if (router.canGoBack()) router.back();
        else if (current)
          router.navigate(listRoute(current), { replace: true });
      },
    },
  ];
}
