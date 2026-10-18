import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAccountHandle } from "../../accounts/context";
import { useSenders } from "../../data/senders";
import type { AccountId, MessageId, ThreadId } from "../../core/ids";
import { isMailError } from "../../core/errors";
import type { Mailbox, Message, MessageSummary } from "../../core/model";
import { useMailboxes, useThread } from "../../data/hooks";
import { isolatingMailboxes, visibleMessages } from "../../data/optimistic";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useUi, useUiStore } from "../../state/context";
import { markReadDelayMs } from "../../state/settings";
import { MailActionButtons } from "../actions/MailActionButtons";
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
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { useUnsubscribe } from "./useUnsubscribe";

/** Props of {@link ConversationView}. */
export interface ConversationViewProps {
  readonly accountId: AccountId;
  /** The row of the conversation (its oldest message's id). */
  readonly rowId: MessageId;
  readonly threadId: ThreadId;
  /** The mailbox being listed (decides which messages show). */
  readonly mailbox: Mailbox | undefined;
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
  onBack,
}: ConversationViewProps) {
  const { data: thread, error, refetch } = useThread(accountId, threadId);
  const { data: mailboxes } = useMailboxes(accountId);
  const actions = useMailActions();
  const compose = useComposeActions();
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
  const answering = () =>
    store.getState().readerCursor ?? messages?.at(-1)?.id ?? rowId;
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
        accountId={accountId}
        messages={messages}
        mailboxes={mailboxes}
        actions={actions}
        compose={compose}
      />
    );
  } else if (error) {
    content = (
      <p className="p-6 text-sm text-zinc-600 dark:text-zinc-400">
        {isMailError(error, "not-found")
          ? "This conversation no longer exists."
          : errorMessage(error)}{" "}
        <button
          type="button"
          className="text-blue-700 underline dark:text-blue-300"
          onClick={() => void refetch()}
        >
          Try again
        </button>
      </p>
    );
  } else {
    content = (
      <div
        aria-busy="true"
        aria-label="Loading conversation"
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
      <div
        role="group"
        aria-label="Conversation actions"
        className="flex min-h-12 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800"
      >
        {onBack && (
          <IconButton
            label="Back to messages"
            icon="arrow-left"
            onClick={onBack}
          />
        )}
        <div className="flex-1" />
        {summary && compose.canCompose && (
          <>
            <IconButton
              label="Reply (r)"
              icon="reply"
              onClick={() => {
                compose.reply(answering(), "reply");
              }}
            />
            <IconButton
              label="Reply all (Shift+R)"
              icon="reply-all"
              onClick={() => {
                compose.reply(answering(), "reply-all");
              }}
            />
            <IconButton
              label="Forward (f)"
              icon="forward"
              onClick={() => {
                compose.forward(answering());
              }}
            />
            <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
          </>
        )}
        {summary && (
          <MailActionButtons
            actions={actions}
            message={summary}
            archivable={
              inbox !== undefined &&
              (messages ?? []).some((m) => m.mailboxIds.includes(inbox.id))
            }
          />
        )}
      </div>
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
  /** The messages that show, oldest first. */
  readonly messages: readonly Message[];
  readonly mailboxes: readonly Mailbox[] | undefined;
  readonly actions: MailActions;
  readonly compose: ComposeActions;
}

function ConversationBody({
  accountId,
  messages,
  mailboxes,
  actions,
  compose,
}: ConversationBodyProps) {
  const subjectId = useId();
  const store = useUiStore();
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
        actions.setSeen(true, { ids, silent: true, exact: true });
    }, delay);
    return () => {
      clearTimeout(timer);
    };
    // Once per set of unread messages, not on every render of `actions`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey, delay]);

  // n / p / Enter inside the conversation.
  const commands = useMemo((): Command[] => {
    const group = "Reading";
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
        description: "Next message in the conversation",
        keys: ["n"],
        run: move(1),
      },
      {
        id: "conversation.previous",
        group,
        description: "Previous message in the conversation",
        keys: ["p"],
        run: move(-1),
      },
      {
        id: "conversation.toggle",
        group,
        description: "Open or close the message at the cursor",
        keys: ["Enter", "o"],
        when: () => store.getState().readerCursor !== null,
        run: () => {
          const id = store.getState().readerCursor;
          if (id !== null) toggle(id);
        },
      },
    ];
  }, [messages, store, domId]);
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
      <div className="space-y-2 border-b border-zinc-200 px-4 py-4 sm:px-6 dark:border-zinc-800">
        <h1
          id={subjectId}
          className="text-lg font-semibold break-words sm:text-xl"
        >
          {first?.subject || "(no subject)"}
          {messages.length > 1 && (
            <span className="ml-2 align-middle text-sm font-normal text-zinc-500">
              {messages.length}
              <span className="sr-only"> messages</span>
            </span>
          )}
        </h1>
        {labels.length > 0 && (
          <ul aria-label="Labels" className="flex flex-wrap gap-1.5">
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
      <ol
        aria-label="Messages"
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
                onClick={() => {
                  toggle(message.id);
                  store.getState().setReaderCursor(message.id);
                }}
                className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left text-sm hover:bg-zinc-50 sm:px-6 dark:hover:bg-zinc-900 pointer-coarse:min-h-11"
              >
                <span
                  className={`w-32 shrink-0 truncate ${message.flags.seen ? "" : "font-semibold"}`}
                >
                  {message.from && mine.has(message.from.address.toLowerCase())
                    ? "me"
                    : displayName(message.from)}
                  {isDraft(message, drafts) && (
                    <span className="ml-1 font-normal text-red-700 dark:text-red-400">
                      Draft
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
                  {formatListDate(message.receivedAt)}
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
  const unsubscribed = useUi((state) => state.unsubscribed.has(message.id));
  const button =
    "flex items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
  return (
    <div>
      <MessageHeader
        message={message}
        mailboxes={mailboxes}
        trailing={
          <>
            {actions.canStar && !draft && (
              <IconButton
                label={
                  message.flags.flagged
                    ? "Unstar this message"
                    : "Star this message"
                }
                icon="star"
                pressed={message.flags.flagged}
                onClick={() => {
                  actions.toggleStar([message.id], { exact: true });
                }}
              />
            )}
            {onCollapse && (
              <IconButton
                label="Close this message"
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
      <MessageBody accountId={accountId} message={message} />
      <AttachmentList accountId={accountId} message={message} />
      {compose.canCompose && (
        <div className="flex flex-wrap gap-2 px-4 pt-1 pb-4 sm:px-6">
          {draft ? (
            <>
              <span className="self-center text-sm font-medium text-red-700 dark:text-red-400">
                Draft
              </span>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.editDraft(message.id);
                }}
              >
                <Icon name="pencil" className="size-4" />
                Edit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.reply(message.id, "reply");
                }}
              >
                <Icon name="reply" className="size-4" />
                Reply
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.reply(message.id, "reply-all");
                }}
              >
                <Icon name="reply-all" className="size-4" />
                Reply all
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  compose.forward(message.id);
                }}
              >
                <Icon name="forward" className="size-4" />
                Forward
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
