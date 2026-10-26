import { messageKey, type AccountId, type MessageId } from "../../core/ids";
import { useMessage } from "../../data/hooks";
import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { mailActionItems } from "../actions/mailActionItems";
import { useMailActions } from "../actions/useMailActions";
import { copyText } from "../common/clipboard";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { displayName } from "../common/format";
import { useMailboxList } from "../common/mailboxNames";
import { entriesOf, grouped } from "../common/menuEntries";
import { useComposeActions } from "../composer/useComposeActions";
import { answerItems } from "./answerItems";
import { originalItems, useOriginalActions } from "../original/originalActions";
import { aiItems, useAiReaderActions } from "../ai/aiItems";
import { aiTarget } from "../ai/useAi";
import { useCurrentList } from "../messages/useCurrentList";

/** Props of {@link MessageMenu}. */
export interface MessageMenuProps {
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  readonly at: MenuPosition;
  readonly onClose: () => void;
}

/**
 * The context menu of one message in the reader (also one message of a
 * conversation): answering it, its flags and mailboxes, and its sender.
 * Everything acts on exactly this message.
 */
export function MessageMenu({
  accountId,
  messageId,
  at,
  onClose,
}: MessageMenuProps) {
  const { data: message } = useMessage(accountId, messageId);
  const { data: mailboxes } = useMailboxList(accountId);
  const actions = useMailActions();
  const compose = useComposeActions();
  const store = useUiStore();
  const router = useRouter();
  const original = useOriginalActions();
  const ai = useAiReaderActions();
  const { sources } = useCurrentList();
  const t = useT();
  const m = t.menus;
  if (!message) return null;
  const inbox = mailboxes?.find((mailbox) => mailbox.role === "inbox")?.id;
  const drafts = mailboxes?.find((mailbox) => mailbox.role === "drafts")?.id;
  const isDraft = drafts !== undefined && message.mailboxIds.includes(drafts);
  const ref = { accountId, messageId: message.id };

  const answering = compose.canWriteFrom(accountId)
    ? entriesOf(answerItems(compose, ref, { isDraft, phone: false }, t))
    : [];
  // In conversation view the panel covers the whole conversation.
  const target =
    sources.get(accountId)?.conversations && message.threadId !== undefined
      ? aiTarget.thread(accountId, message.threadId)
      : aiTarget.message(accountId, message.id);
  const asking = entriesOf(
    aiItems(
      ai,
      target,
      compose.canWriteFrom(accountId) && !isDraft ? ref : undefined,
      { phone: false },
      t,
    ),
  );
  const acting = entriesOf(
    mailActionItems(
      actions,
      {
        keys: [messageKey(accountId, message.id)],
        exact: true,
        message,
        accountId,
        archivable: inbox !== undefined && message.mailboxIds.includes(inbox),
      },
      t.actions,
    ),
  );
  const from = message.from;
  // Where a search for the sender starts: the list shown, or the Inbox.
  const route = router.getRoute();
  const searchIn =
    route?.accountId === accountId
      ? route.mailboxId
      : (inbox ?? message.mailboxIds[0]);
  const sender: MenuEntry[] =
    from && (route?.unified || searchIn !== undefined)
      ? [
          {
            id: "mail-from",
            label: m.mailFrom(displayName(from, t.common.unknownSender)),
            icon: "search",
            run: () => {
              const search = { text: `from:${from.address}`, everywhere: true };
              if (route?.unified)
                router.navigate({
                  accountId: route.accountId,
                  mailboxId: route.mailboxId,
                  unified: true,
                  search,
                });
              else if (searchIn !== undefined)
                router.navigate({ accountId, mailboxId: searchIn, search });
            },
          },
          {
            id: "copy-sender",
            label: m.copySender,
            icon: "user",
            run: () => {
              copyText(from.address, store, t);
            },
          },
        ]
      : [];
  const title = message.subject || t.common.noSubject;
  return (
    <ContextMenu
      label={title}
      title={title}
      at={at}
      entries={grouped(
        answering,
        asking,
        acting,
        sender,
        entriesOf(originalItems(original, ref, t)),
      )}
      onClose={onClose}
    />
  );
}
