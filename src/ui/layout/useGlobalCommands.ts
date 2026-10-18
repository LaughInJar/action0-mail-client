import { useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import type { MailboxRole } from "../../core/model";
import type { Command } from "../../keyboard/registry";
import { useCommands } from "../../keyboard/context";
import { useRoute, useRouter, useUiStore } from "../../state/context";
import { listRoute } from "../../state/router";
import { focusWhenReady } from "../common/focusWhenReady";
import { FOLDER_FILTER_ID } from "../mailboxes/FolderFilter";
import { SEARCH_FIELD_ID } from "../messages/ListToolbar";
import type { Breakpoint } from "./useBreakpoint";
import { useT } from "../../i18n/context";
import { useMailboxList } from "../common/mailboxNames";

/** Id of the scroll container of the reader, for the scroll shortcuts. */
export const READER_SCROLL_ID = "reader-scroll";

const GO_TO: readonly (readonly [
  string,
  MailboxRole,
  "goInbox" | "goSent" | "goDrafts" | "goAll",
])[] = [
  ["g i", "inbox", "goInbox"],
  ["g s", "sent", "goSent"],
  ["g d", "drafts", "goDrafts"],
  ["g a", "all", "goAll"],
];

/** Shortcuts that work everywhere: go-to, search, reader scrolling, help. */
export function useGlobalCommands(breakpoint: Breakpoint): void {
  const route = useRoute();
  const router = useRouter();
  const store = useUiStore();
  const accounts = useAccounts();
  const accountId = route?.accountId ?? accounts[0]?.account.id;
  const { data: mailboxes } = useMailboxList(accountId);
  const t = useT();

  const commands = useMemo((): Command[] => {
    const reader = () => document.getElementById(READER_SCROLL_ID);
    const scrollReader = (direction: 1 | -1) => {
      const element = reader();
      element?.scrollBy({
        top: direction * element.clientHeight * 0.85,
        behavior: "smooth",
      });
    };

    const goTo = GO_TO.flatMap(([keys, role, text]): Command[] => {
      const mailbox = mailboxes?.find((candidate) => candidate.role === role);
      if (!mailbox || accountId === undefined) return [];
      return [
        {
          id: `go.${role}`,
          group: "goTo",
          description: t.shortcuts[text],
          keys: [keys],
          run: () => {
            router.navigate({ accountId, mailboxId: mailbox.id });
          },
        },
      ];
    });

    return [
      ...goTo,
      {
        id: "search.mail",
        group: "search",
        description: t.shortcuts.searchMail,
        keys: ["/"],
        when: () => router.getRoute() !== null,
        run: () => {
          const current = router.getRoute();
          // Phones with the reader open: back to the list, which has the field.
          if (breakpoint === "narrow" && current?.messageId !== undefined)
            router.navigate(listRoute(current));
          focusWhenReady(SEARCH_FIELD_ID);
        },
      },
      {
        id: "search.folders",
        group: "search",
        description: t.shortcuts.filterFolders,
        keys: ["g f"],
        run: () => {
          if (breakpoint === "medium") store.getState().setDrawerOpen(true);
          else if (breakpoint === "narrow") router.navigate(null);
          focusWhenReady(FOLDER_FILTER_ID);
        },
      },
      {
        id: "reader.page-down",
        group: "reading",
        description: t.shortcuts.scrollDown,
        keys: ["Space"],
        when: () => reader() !== null,
        run: () => {
          scrollReader(1);
        },
      },
      {
        id: "reader.page-up",
        group: "reading",
        description: t.shortcuts.scrollUp,
        keys: ["shift+Space"],
        when: () => reader() !== null,
        run: () => {
          scrollReader(-1);
        },
      },
      {
        id: "help.toggle",
        group: "general",
        description: t.shortcuts.showShortcuts,
        keys: ["?"],
        run: () => {
          const { helpOpen, setHelpOpen } = store.getState();
          setHelpOpen(!helpOpen);
        },
      },
    ];
  }, [accountId, breakpoint, mailboxes, router, store, t]);

  useCommands(commands);
}
