import { useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import type { MailboxRole } from "../../core/model";
import { useMailboxes } from "../../data/hooks";
import type { Command } from "../../keyboard/registry";
import { useCommands } from "../../keyboard/context";
import { useRoute, useRouter, useUiStore } from "../../state/context";

/** Id of the scroll container of the reader, for the scroll shortcuts. */
export const READER_SCROLL_ID = "reader-scroll";

const GO_TO: readonly (readonly [string, MailboxRole, string])[] = [
  ["g i", "inbox", "Go to Inbox"],
  ["g s", "sent", "Go to Sent"],
  ["g d", "drafts", "Go to Drafts"],
  ["g a", "all", "Go to All Mail"],
];

/** Shortcuts that work everywhere: go-to, reader scrolling, help. */
export function useGlobalCommands(): void {
  const route = useRoute();
  const router = useRouter();
  const store = useUiStore();
  const accounts = useAccounts();
  const accountId = route?.accountId ?? accounts[0]?.account.id;
  const { data: mailboxes } = useMailboxes(accountId);

  const commands = useMemo((): Command[] => {
    const reader = () => document.getElementById(READER_SCROLL_ID);
    const scrollReader = (direction: 1 | -1) => {
      const element = reader();
      element?.scrollBy({
        top: direction * element.clientHeight * 0.85,
        behavior: "smooth",
      });
    };

    const goTo = GO_TO.flatMap(([keys, role, description]): Command[] => {
      const mailbox = mailboxes?.find((candidate) => candidate.role === role);
      if (!mailbox || accountId === undefined) return [];
      return [
        {
          id: `go.${role}`,
          group: "Go to",
          description,
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
        id: "reader.page-down",
        group: "Reading",
        description: "Scroll the message down",
        keys: ["Space"],
        when: () => reader() !== null,
        run: () => {
          scrollReader(1);
        },
      },
      {
        id: "reader.page-up",
        group: "Reading",
        description: "Scroll the message up",
        keys: ["shift+Space"],
        when: () => reader() !== null,
        run: () => {
          scrollReader(-1);
        },
      },
      {
        id: "help.toggle",
        group: "General",
        description: "Show keyboard shortcuts",
        keys: ["?"],
        run: () => {
          const { helpOpen, setHelpOpen } = store.getState();
          setHelpOpen(!helpOpen);
        },
      },
    ];
  }, [accountId, mailboxes, router, store]);

  useCommands(commands);
}
