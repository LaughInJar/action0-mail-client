import { useId, type ReactNode } from "react";
import {
  messageKey,
  messageRef,
  type AccountId,
  type MessageId,
  type MessageRef,
  type ThreadId,
} from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { isMailError } from "../../core/errors";
import { useMessage } from "../../data/hooks";
import { useRoute, useRouter, useUi } from "../../state/context";
import { listRoute } from "../../state/router";
import { markReadDelayMs } from "../../state/settings";
import { errorMessage } from "../common/errorMessage";
import { IconButton } from "../common/IconButton";
import { READER_SCROLL_ID } from "../layout/useGlobalCommands";
import { useBreakpoint, type Breakpoint } from "../layout/useBreakpoint";
import { mailActionItems } from "../actions/mailActionItems";
import { OverflowToolbar } from "../common/OverflowToolbar";
import { originalItems, useOriginalActions } from "../original/originalActions";
import { answerItems } from "./answerItems";
import { useMailActions } from "../actions/useMailActions";
import {
  keyOfRoute,
  listKeyOf,
  useCurrentList,
} from "../messages/useCurrentList";
import { AccountLine } from "./AccountLine";
import { ConversationView } from "./ConversationView";
import { Icon } from "../common/Icon";
import {
  useComposeActions,
  type ComposeActions,
} from "../composer/useComposeActions";
import { AttachmentList } from "./AttachmentList";
import { InvitationBar } from "./InvitationBar";
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { useMarkReadOnView } from "./useMarkReadOnView";
import { useUnsubscribe } from "./useUnsubscribe";
import { useMessageMenu } from "./useMessageMenu";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";

/** Column (c): the focused message, or a summary of the multi-selection. */
export function ReaderPane({ breakpoint }: { breakpoint: Breakpoint }) {
  const route = useRoute();
  const t = useT();
  const r = t.reader;
  const { rows, sources, unified } = useCurrentList();
  const router = useRouter();
  const listKey = listKeyOf(
    route,
    useUi((state) => state.listOrder),
    useUi((state) => state.settings.conversations),
  );
  const focusedId = useUi((state) =>
    state.listKey === listKey ? state.focusedId : null,
  );
  const selectedCount = useUi((state) => state.selectedIds.size);

  // Phones show exactly the message in the URL; larger screens show the cursor.
  const routeKey = keyOfRoute(route);
  const openKey = breakpoint === "narrow" ? routeKey : (focusedId ?? routeKey);
  const open = openKey === null ? undefined : messageRef(openKey);
  const messageId = open?.messageId;

  const back =
    breakpoint === "narrow"
      ? () => {
          if (router.canGoBack()) router.back();
          else if (route) router.navigate(listRoute(route), { replace: true });
        }
      : undefined;

  if (selectedCount > 1 && breakpoint !== "narrow") {
    return (
      <Placeholder title={r.selectedCount(selectedCount)}>
        {r.clearSelectionHint.before}{" "}
        <kbd className="font-sans font-semibold">{t.shortcuts.keys.escape}</kbd>
        {r.clearSelectionHint.after}
      </Placeholder>
    );
  }
  if (!route || open === undefined || messageId === undefined) {
    return (
      <Placeholder title={r.noMessageSelected}>
        {r.navigationHint.before}{" "}
        <kbd className="font-sans font-semibold">j</kbd> {r.navigationHint.and}{" "}
        <kbd className="font-sans font-semibold">k</kbd>{" "}
        {r.navigationHint.middle}{" "}
        <kbd className="font-sans font-semibold">?</kbd>{" "}
        {r.navigationHint.after}
      </Placeholder>
    );
  }
  // The open row's account: in All inboxes not necessarily the route's yet.
  const { accountId } = open;
  const source = sources.get(accountId);
  const account = unified ? { inAccount: true as const } : {};
  if (source?.conversations)
    return (
      <ConversationRow
        key={openKey}
        accountId={accountId}
        rowId={messageId}
        threadId={rows?.find((row) => row.key === openKey)?.thread?.id}
        mailbox={source.scope}
        {...account}
        {...(back ? { onBack: back } : {})}
      />
    );
  return (
    <MessageView
      key={openKey}
      accountId={accountId}
      messageId={messageId}
      {...account}
      {...(back ? { onBack: back } : {})}
    />
  );
}

/**
 * The conversation of a row. Its id is known from the list; after a reload
 * (before the list is there) it comes from the row's message.
 */
function ConversationRow({
  accountId,
  rowId,
  threadId,
  mailbox,
  inAccount = false,
  onBack,
}: {
  readonly accountId: AccountId;
  readonly rowId: MessageId;
  readonly threadId: ThreadId | undefined;
  readonly mailbox: Mailbox | undefined;
  /** Name the account (All inboxes). */
  readonly inAccount?: boolean;
  readonly onBack?: () => void;
}) {
  const t = useT();
  const { data: message, error } = useMessage(
    accountId,
    threadId === undefined ? rowId : undefined,
  );
  const id = threadId ?? message?.threadId;
  if (id === undefined)
    return error ? (
      <Placeholder title={t.reader.conversationGone}>
        {errorMessage(error, t)}
      </Placeholder>
    ) : (
      <ReaderSkeleton />
    );
  return (
    <ConversationView
      accountId={accountId}
      rowId={rowId}
      threadId={id}
      mailbox={mailbox}
      inAccount={inAccount}
      {...(onBack ? { onBack } : {})}
    />
  );
}

interface MessageViewProps {
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  /** Name the account (All inboxes). */
  readonly inAccount?: boolean;
  readonly onBack?: () => void;
}

function MessageView({
  accountId,
  messageId,
  inAccount = false,
  onBack,
}: MessageViewProps) {
  const t = useT();
  const breakpoint = useBreakpoint();
  const subjectId = useId();
  const { data: message, error, refetch } = useMessage(accountId, messageId);
  const { data: mailboxes } = useMailboxList(accountId);
  const actions = useMailActions();
  const markRead = useUi((state) => state.settings.markRead);
  useMarkReadOnView(
    message,
    (id) => {
      actions.setSeen(true, {
        keys: [messageKey(accountId, id)],
        silent: true,
      });
    },
    markReadDelayMs(markRead),
  );
  const inbox = mailboxes?.find((mailbox) => mailbox.role === "inbox");
  const inInbox = !!message && !!inbox && message.mailboxIds.includes(inbox.id);
  const compose = useComposeActions();
  const original = useOriginalActions();
  const canWrite = compose.canWriteFrom(accountId);
  const drafts = mailboxes?.find((mailbox) => mailbox.role === "drafts");
  const isDraft =
    !!message && !!drafts && message.mailboxIds.includes(drafts.id);
  const unsubscribe = useUnsubscribe();
  const unsubscribed = useUi((state) => state.unsubscribed.has(messageId));
  const handlers = useMessageMenu(accountId);
  // The header has no click of its own: the long press needs no swallowing.
  const menuOf = (id: MessageId) => {
    const { consumeClick: _consume, onKeyDown: _keys, ...rest } = handlers(id);
    return rest;
  };

  let content;
  if (message) {
    content = (
      <article aria-labelledby={subjectId}>
        {inAccount && <AccountLine accountId={accountId} />}
        {/* Right-click or a long press: what can be done with it. */}
        <div {...menuOf(message.id)}>
          <MessageHeader
            message={message}
            mailboxes={mailboxes}
            subjectId={subjectId}
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
        {canWrite && (
          <AnswerButtons
            compose={compose}
            message={{ accountId, messageId: message.id }}
            isDraft={isDraft}
          />
        )}
      </article>
    );
  } else if (error) {
    content = (
      <p className="p-6 text-sm text-zinc-600 dark:text-zinc-400">
        {isMailError(error, "not-found")
          ? t.reader.messageGone
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
    content = <ReaderSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OverflowToolbar
        label={t.reader.messageActions}
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
          message
            ? [
                ...(canWrite
                  ? answerItems(
                      compose,
                      { accountId, messageId: message.id },
                      { isDraft, phone: breakpoint === "narrow" },
                      t,
                    )
                  : []),
                ...mailActionItems(
                  actions,
                  { message, accountId, archivable: inInbox },
                  t.actions,
                ),
                ...originalItems(
                  original,
                  { accountId, messageId: message.id },
                  t,
                ),
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

/** Big Reply / Reply all / Forward buttons below the message (touch friendly). */
function AnswerButtons({
  compose,
  message,
  isDraft,
}: {
  compose: ComposeActions;
  message: MessageRef;
  isDraft: boolean;
}) {
  const t = useT();
  const button =
    "flex items-center gap-2 rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
  if (isDraft)
    return (
      <div className="flex flex-wrap gap-2 px-4 pt-2 pb-6 sm:px-6">
        <button
          type="button"
          className={button}
          onClick={() => {
            compose.editDraft(message);
          }}
        >
          <Icon name="pencil" className="size-4" />
          {t.reader.editDraft}
        </button>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-2 pb-6 sm:px-6">
      <button
        type="button"
        className={button}
        onClick={() => {
          compose.reply(message, "reply");
        }}
      >
        <Icon name="reply" className="size-4" />
        {t.reader.reply}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          compose.reply(message, "reply-all");
        }}
      >
        <Icon name="reply-all" className="size-4" />
        {t.reader.replyAll}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          compose.forward(message);
        }}
      >
        <Icon name="forward" className="size-4" />
        {t.reader.forward}
      </button>
    </div>
  );
}

function Placeholder({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-xs space-y-1">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
        <p className="text-sm text-zinc-500">{children}</p>
      </div>
    </div>
  );
}

function ReaderSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      aria-label={t.reader.loadingMessage}
      className="animate-pulse space-y-4 p-6"
    >
      <div className="h-5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-1/3 rounded bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="space-y-2 pt-4">
        <div className="h-3 rounded bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-3 rounded bg-zinc-100 dark:bg-zinc-800/60" />
        <div className="h-3 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800/60" />
      </div>
    </div>
  );
}
