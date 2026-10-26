import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAccountHandle } from "../../accounts/context";
import { useSenders } from "../../data/senders";
import {
  messageKey,
  type AccountId,
  type MessageId,
  type ThreadId,
} from "../../core/ids";
import { isMailError } from "../../core/errors";
import type { Mailbox, Message, MessageSummary } from "../../core/model";
import { useThread } from "../../data/hooks";
import { isolatingMailboxes, visibleMessages } from "../../data/optimistic";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useUi, useUiStore } from "../../state/context";
import { markReadDelayMs } from "../../state/settings";
import { mailActionItems } from "../actions/mailActionItems";
import { OverflowToolbar } from "../common/OverflowToolbar";
import { useBreakpoint } from "../layout/useBreakpoint";
import { originalItems, useOriginalActions } from "../original/originalActions";
import { answerItems } from "./answerItems";
import { useMailActions, type MailActions } from "../actions/useMailActions";
import { errorMessage } from "../common/errorMessage";
import { displayName, formatListDate } from "../common/format";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import {
  useComposeActions,
  type ComposeActions,
} from "../composer/useComposeActions";
import { READER_SCROLL_ID } from "../layout/useGlobalCommands";
import { AttachmentList } from "./AttachmentList";
import { InvitationBar } from "./InvitationBar";
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { useUnsubscribe } from "./useUnsubscribe";
import { AccountLine } from "./AccountLine";
import { useMessageMenu } from "./useMessageMenu";
import { useT } from "../../i18n/context";
import { useMailboxList } from "../common/mailboxNames";
import { AiPanel } from "../ai/AiPanel";
import { aiItems, useAiCommands, useAiReaderActions } from "../ai/aiItems";
import { aiTarget } from "../ai/useAi";

/** Props of {@link ConversationView}. */
export interface ConversationViewProps {
  readonly accountId: AccountId;
  /** The row of the conversation (its oldest message's id). */
  readonly rowId: MessageId;
  readonly threadId: ThreadId;
  /** The mailbox being listed (decides which messages show). */
  readonly mailbox: Mailbox | undefined;
  /** Name the account (All inboxes). */
  readonly inAccount?: boolean;
  readonly onBack?: () => void;
}

/**
 * A conversation in the reader: the subject once, then its messages oldest
 * first. Unread messages and the newest one are open, older read ones are
 * a line each. `n`/`p` move the cursor between messages, Enter opens or
 * closes the one at the cursor, `r`/`f` answer it.
 */
export function ConversationView({
  accountId,
  rowId,
  threadId,
  mailbox,
  inAccount = false,
  onBack,
}: ConversationViewProps) {
  const { data: thread, error, refetch } = useThread(accountId, threadId);
  const t = useT();
  const breakpoint = useBreakpoint();
  const { data: mailboxes } = useMailboxList(accountId);
  const actions = useMailActions();
  const compose = useComposeActions();
  const original = useOriginalActions();
  const messages = useMemo(() => {
    if (!thread) return undefined;
    if (!mailbox) return thread.messages;
    const shown = visibleMessages(
      thread,
      mailbox,
      isolatingMailboxes(mailboxes ?? []),
    );
    return shown.length > 0 ? shown : thread.messages;
  }, [thread, mailbox, mailboxes]);

  const inbox = mailboxes?.find((m) => m.role === "inbox");
  const store = useUiStore();
  /** The message the toolbar answers: the one at the cursor, else the newest. */
  const answering = () => ({
    accountId,
    messageId: store.getState().readerCursor ?? messages?.at(-1)?.id ?? rowId,
  });
  const canWrite = compose.canWriteFrom(accountId);
  const ai = useAiReaderActions();
  const target = aiTarget.thread(accountId, threadId);
  useAiCommands(ai, thread ? target : undefined);
  // The conversation as one item for the toolbar: read if all are, starred if any is.
  const newest = messages?.at(-1);
  const summary: MessageSummary | undefined = newest && {
    ...newest,
    id: rowId,
    flags: {
      seen: (messages ?? []).every((message) => message.flags.seen),
      flagged: (messages ?? []).some((message) => message.flags.flagged),
    },
  };

  let content;
  if (messages && thread) {
    content = (
      <ConversationBody
        key={thread.id}
        inAccount={inAccount}
        accountId={accountId}
        messages={messages}
        mailboxes={mailboxes}
        actions={actions}
        compose={compose}
        aiTarget={target}
        {...(canWrite
          ? {
              onAiReply: () => {
                ai.reply(answering());
              },
            }
          : {})}
      />
    );
  } else if (error) {
    content = (
      <p className="p-6 text-sm text-zinc-600 dark:text-zinc-400">
        {isMailError(error, "not-found")
          ? t.reader.conversationGoneText
          : errorMessage(error, t)}{" "}
        <button
          type="button"
          className="text-blue-700 underline dark:text-blue-300"
          onClick={() => void refetch()}
        >
          {t.common.tryAgain}
        </button>
      </p>
    );
  } else {
    content = (
      <div
        aria-busy="true"
        aria-label={t.reader.loadingConversation}
        className="animate-pulse space-y-4 p-6"
      >
        <div className="h-5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-12 rounded bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-24 rounded bg-zinc-100 dark:bg-zinc-800/60" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OverflowToolbar
        label={t.reader.conversationActions}
        moreLabel={t.reader.moreActions}
        {...(onBack
          ? {
              leading: (
                <IconButton
                  label={t.reader.backToMessages}
                  icon="arrow-left"
                  onClick={onBack}
                />
              ),
            }
          : {})}
        items={
          summary
            ? [
                ...(canWrite
                  ? answerItems(
                      compose,
                      answering,
                      { isDraft: false, phone: breakpoint === "narrow" },
                      t,
                    )
                  : []),
                ...mailActionItems(
                  actions,
                  {
                    message: summary,
                    accountId,
                    archivable:
                      inbox !== undefined &&
                      (messages ?? []).some((m) =>
                        m.mailboxIds.includes(inbox.id),
                      ),
                  },
                  t.actions,
                ),
                ...aiItems(
                  ai,
                  target,
                  canWrite ? answering : undefined,
                  { phone: breakpoint === "narrow" },
                  t,
                ),
                ...originalItems(original, answering, t),
              ]
            : []
        }
      />
      <div
        id={READER_SCROLL_ID}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {content}
      </div>
    </div>
  );
}

interface ConversationBodyProps {
  readonly accountId: AccountId;
  readonly inAccount: boolean;
  /** The messages that show, oldest first. */
  readonly messages: readonly Message[];
  readonly mailboxes: readonly Mailbox[] | undefined;
  readonly actions: MailActions;
  readonly compose: ComposeActions;
  /** The AI panel's target (the whole conversation). */
  readonly aiTarget: string;
  /** Reply with AI (none when the account can't write). */
  readonly onAiReply?: () => void;
}

function ConversationBody({
  accountId,
  inAccount,
  messages,
  mailboxes,
  actions,
  compose,
  aiTarget: target,
  onAiReply,
}: ConversationBodyProps) {
  const subjectId = useId();
  const menuOf = useMessageMenu(accountId);
  // Folded lines: right-click, long press and the Menu key open its menu.
  const folded = (id: MessageId) => {
    const { consumeClick: _consume, ...handlers } = menuOf(id);
    return handlers;
  };
  const store = useUiStore();
  const t = useT();
  const cursor = useUi((state) => state.readerCursor);
  const markRead = useUi((state) => state.settings.markRead);
  const drafts = mailboxes?.find((m) => m.role === "drafts")?.id;
  const newest = messages.at(-1);
  const email = useAccountHandle(accountId)?.account.email;
  const { data: senders } = useSenders(accountId);
  const mine = new Set(
    [email ?? "", ...(senders ?? []).map((sender) => sender.address)].map(
      (address) => address.toLowerCase(),
    ),
  );
  // What was there and unread when the conversation opened stays open.
  const [atOpen] = useState(() => ({
    ids: new Set(messages.map((message) => message.id)),
    unread: new Set(
      messages.filter((m) => !m.flags.seen).map((message) => message.id),
    ),
    newest: messages.at(-1)?.id,
  }));
  const [toggled, setToggled] = useState<ReadonlySet<MessageId>>(new Set());
  const openByDefault = (message: Message) =>
    message === newest ||
    message.id === atOpen.newest ||
    atOpen.unread.has(message.id) ||
    (!atOpen.ids.has(message.id) && !message.flags.seen);
  const isOpen = (message: Message) =>
    openByDefault(message) !== toggled.has(message.id);
  const toggle = (id: MessageId) => {
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  // The cursor starts on the newest message; r/f answer it.
  const newestId = newest?.id;
  const current =
    cursor !== null && messages.some((m) => m.id === cursor)
      ? cursor
      : (newestId ?? null);
  useEffect(() => {
    store.getState().setReaderCursor(newestId ?? null);
    return () => {
      store.getState().setReaderCursor(null);
    };
  }, [store, newestId]);

  // Open on the first unread message, else the newest.
  const domId = useId();
  const messageDomId = (index: number) => `${domId}-${String(index)}`;
  const [firstShown] = useState(() => {
    const unread = messages.findIndex((m) => !m.flags.seen);
    return unread === -1 ? messages.length - 1 : unread;
  });
  useEffect(() => {
    if (messages.length < 2) return;
    scrollReaderTo(document.getElementById(`${domId}-${String(firstShown)}`));
    // Only when the conversation opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstShown]);

  // Unread messages count as read after the mark-as-read delay.
  const unreadIds = messages
    .filter((m) => !m.flags.seen && !isDraft(m, drafts))
    .map((m) => m.id);
  const unreadKey = unreadIds.join(" ");
  const latestUnread = useRef(unreadIds);
  useEffect(() => {
    latestUnread.current = unreadIds;
  });
  const delay = markReadDelayMs(markRead);
  useEffect(() => {
    if (delay === null || unreadKey === "") return;
    const timer = setTimeout(() => {
      const ids = latestUnread.current;
      if (ids.length > 0)
        actions.setSeen(true, {
          keys: ids.map((id) => messageKey(accountId, id)),
          silent: true,
          exact: true,
        });
    }, delay);
    return () => {
      clearTimeout(timer);
    };
    // Once per set of unread messages, not on every render of `actions`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey, delay]);

  // n / p / Enter inside the conversation.
  const commands = useMemo((): Command[] => {
    const group = "reading";
    const move = (delta: number) => () => {
      const ids = messages.map((m) => m.id);
      const cursorId = store.getState().readerCursor;
      const at = cursorId === null ? ids.length - 1 : ids.indexOf(cursorId);
      const next = ids[Math.max(0, Math.min(ids.length - 1, at + delta))];
      if (next === undefined) return;
      store.getState().setReaderCursor(next);
      scrollReaderTo(
        document.getElementById(`${domId}-${String(ids.indexOf(next))}`),
        "nearest",
      );
    };
    return [
      {
        id: "conversation.next",
        group,
        description: t.shortcuts.nextInConversation,
        keys: ["n"],
        run: move(1),
      },
      {
        id: "conversation.previous",
        group,
        description: t.shortcuts.previousInConversation,
        keys: ["p"],
        run: move(-1),
      },
      {
        id: "conversation.toggle",
        group,
        description: t.shortcuts.toggleInConversation,
        keys: ["Enter", "o"],
        when: () => store.getState().readerCursor !== null,
        run: () => {
          const id = store.getState().readerCursor;
          if (id !== null) toggle(id);
        },
      },
    ];
  }, [messages, store, domId, t]);
  useCommands(commands);

  const first = messages[0];
  const labels = (mailboxes ?? []).filter(
    (mailbox) =>
      mailbox.kind === "label" &&
      mailbox.role === undefined &&
      messages.some((message) => message.mailboxIds.includes(mailbox.id)),
  );

  return (
    <article aria-labelledby={subjectId}>
      {inAccount && <AccountLine accountId={accountId} />}
      <div className="space-y-2 border-b border-zinc-200 px-4 py-4 sm:px-6 dark:border-zinc-800">
        <h1
          id={subjectId}
          className="text-lg font-semibold break-words sm:text-xl"
        >
          {first?.subject || t.common.noSubject}
          {messages.length > 1 && (
            <span className="ml-2 align-middle text-sm font-normal text-zinc-500">
              {messages.length}
              <span className="sr-only">{t.reader.messageCount}</span>
            </span>
          )}
        </h1>
        {labels.length > 0 && (
          <ul aria-label={t.labels.labels} className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <li
                key={label.id}
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${label.color ? "" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
                style={
                  label.color
                    ? {
                        backgroundColor: label.color.background,
                        color: label.color.text,
                      }
                    : undefined
                }
              >
                {label.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AiPanel
        target={target}
        messages={messages}
        {...(onAiReply ? { onReply: onAiReply } : {})}
      />
      <ol
        aria-label={t.reader.messagesOfConversation}
        className="divide-y divide-zinc-200 dark:divide-zinc-800"
      >
        {messages.map((message, index) => (
          <li
            key={message.id}
            id={messageDomId(index)}
            aria-current={message.id === current || undefined}
            className={`scroll-mt-2 ${message.id === current ? "shadow-[inset_3px_0_0] shadow-blue-500" : ""}`}
          >
            {isOpen(message) ? (
              <OpenMessage
                accountId={accountId}
                message={message}
                mailboxes={mailboxes}
                draft={isDraft(message, drafts)}
                actions={actions}
                compose={compose}
                onCollapse={
                  message === newest
                    ? undefined
                    : () => {
                        toggle(message.id);
                        store.getState().setReaderCursor(message.id);
                      }
                }
              />
            ) : (
              <button
                type="button"
                {...folded(message.id)}
                onClick={() => {
                  if (menuOf(message.id).consumeClick()) return;
                  toggle(message.id);
                  store.getState().setReaderCursor(message.id);
                }}
                className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left text-sm hover:bg-zinc-50 sm:px-6 dark:hover:bg-zinc-900 pointer-coarse:min-h-11"
              >
                <span
                  className={`w-32 shrink-0 truncate ${message.flags.seen ? "" : "font-semibold"}`}
                >
                  {message.from && mine.has(message.from.address.toLowerCase())
                    ? t.common.me
                    : displayName(message.from, t.common.unknownSender)}
                  {isDraft(message, drafts) && (
                    <span className="ml-1 font-normal text-red-700 dark:text-red-400">
                      {t.reader.draft}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
                  {message.snippet}
                </span>
                <time
                  dateTime={message.receivedAt}
                  className="shrink-0 text-xs text-zinc-500"
                >
                  {formatListDate(message.receivedAt, { locale: t.locale })}
                </time>
              </button>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

/**
 * Scrolls the reader (only the reader: `scrollIntoView` would also move the
 * page on phones, taking the toolbar along) so `element` shows: at the top,
 * or just into view (`nearest`).
 */
function scrollReaderTo(
  element: HTMLElement | null,
  block: "start" | "nearest" = "start",
) {
  const reader = document.getElementById(READER_SCROLL_ID);
  if (!element || !reader) return;
  const box = element.getBoundingClientRect();
  const view = reader.getBoundingClientRect();
  if (block === "start" || box.top < view.top)
    reader.scrollTop += box.top - view.top;
  else if (box.bottom > view.bottom)
    reader.scrollTop += Math.min(box.bottom - view.bottom, box.top - view.top);
}

const isDraft = (message: Message, drafts: Mailbox["id"] | undefined) =>
  drafts !== undefined && message.mailboxIds.includes(drafts);

interface OpenMessageProps {
  readonly accountId: AccountId;
  readonly message: Message;
  readonly mailboxes: readonly Mailbox[] | undefined;
  readonly draft: boolean;
  readonly actions: MailActions;
  readonly compose: ComposeActions;
  /** Closes it to one line (not the newest message). */
  readonly onCollapse: (() => void) | undefined;
}

/** One open message of a conversation: header, body, files and answers. */
function OpenMessage({
  accountId,
  message,
  mailboxes,
  draft,
  actions,
  compose,
  onCollapse,
}: OpenMessageProps) {
  const unsubscribe = useUnsubscribe();
  const t = useT();
  const unsubscribed = useUi((state) => state.unsubscribed.has(message.id));
  const {
    consumeClick: _consume,
    onKeyDown: _keys,
    ...headerMenu
  } = useMessageMenu(accountId)(message.id);
  const button =
    "flex items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
  return (
    <div>
      {/* Right-click or a long press: what can be done with it. */}
      <div {...headerMenu}>
        <MessageHeader
          message={message}
          mailboxes={mailboxes}
          trailing={
            <>
              {actions.canStar && !draft && (
                <IconButton
                  label={
                    message.flags.flagged
                      ? t.reader.unstarMessage
                      : t.reader.starMessage
                  }
                  icon="star"
                  pressed={message.flags.flagged}
                  onClick={() => {
                    actions.toggleStar([messageKey(accountId, message.id)], {
                      exact: true,
                    });
                  }}
                />
              )}
              {onCollapse && (
                <IconButton
                  label={t.reader.closeMessage}
                  icon="chevron-up"
                  onClick={onCollapse}
                />
              )}
            </>
          }
          {...(message.unsubscribe
            ? {
                unsubscribe: {
                  done: unsubscribed,
                  onClick: () => {
                    unsubscribe.request(accountId, message);
                  },
                },
              }
            : {})}
        />
      </div>
      <InvitationBar accountId={accountId} message={message} />
      <MessageBody accountId={accountId} message={message} />
      <AttachmentList accountId={accountId} message={message} />
      {compose.canWriteFrom(accountId) && (
        <div className="flex flex-wrap gap-2 px-4 pt-1 pb-4 sm:px-6">
          {draft ? (
            <>
              <span className="self-center text-sm font-medium text-red-700 dark:text-red-400">
                {t.reader.draft}
              </span>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.editDraft({ accountId, messageId: message.id });
                }}
              >
                <Icon name="pencil" className="size-4" />
                {t.common.edit}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.reply({ accountId, messageId: message.id }, "reply");
                }}
              >
                <Icon name="reply" className="size-4" />
                {t.reader.reply}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.reply(
                    { accountId, messageId: message.id },
                    "reply-all",
                  );
                }}
              >
                <Icon name="reply-all" className="size-4" />
                {t.reader.replyAll}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.forward({ accountId, messageId: message.id });
                }}
              >
                <Icon name="forward" className="size-4" />
                {t.reader.forward}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
