import { useId, type ReactNode } from "react";
import type { AccountId, MessageId } from "../../core/ids";
import { isMailError } from "../../core/errors";
import { useMailboxes, useMessage } from "../../data/hooks";
import { useRoute, useRouter, useUi } from "../../state/context";
import { listRoute } from "../../state/router";
import { errorMessage } from "../common/errorMessage";
import { IconButton } from "../common/IconButton";
import { READER_SCROLL_ID } from "../layout/useGlobalCommands";
import type { Breakpoint } from "../layout/useBreakpoint";
import { MailActionButtons } from "../actions/MailActionButtons";
import { useMailActions } from "../actions/useMailActions";
import { listKeyOf } from "../messages/useCurrentList";
import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { useMarkReadOnView } from "./useMarkReadOnView";

/** Column (c): the focused message, or a summary of the multi-selection. */
export function ReaderPane({ breakpoint }: { breakpoint: Breakpoint }) {
  const route = useRoute();
  const router = useRouter();
  const listKey = listKeyOf(
    route,
    useUi((state) => state.listOrder),
  );
  const focusedId = useUi((state) =>
    state.listKey === listKey ? state.focusedId : null,
  );
  const selectedCount = useUi((state) => state.selectedIds.size);

  // Phones show exactly the message in the URL; larger screens show the cursor.
  const messageId =
    breakpoint === "narrow"
      ? route?.messageId
      : (focusedId ?? route?.messageId);

  const back =
    breakpoint === "narrow"
      ? () => {
          if (router.canGoBack()) router.back();
          else if (route) router.navigate(listRoute(route), { replace: true });
        }
      : undefined;

  if (selectedCount > 1 && breakpoint !== "narrow") {
    return (
      <Placeholder title={`${selectedCount} messages selected`}>
        Press <kbd className="font-sans font-semibold">Esc</kbd> to clear the
        selection.
      </Placeholder>
    );
  }
  if (!route || messageId === undefined) {
    return (
      <Placeholder title="No message selected">
        Use <kbd className="font-sans font-semibold">j</kbd> and{" "}
        <kbd className="font-sans font-semibold">k</kbd> to move through the
        list, <kbd className="font-sans font-semibold">?</kbd> for all
        shortcuts.
      </Placeholder>
    );
  }
  return (
    <MessageView
      key={messageId}
      accountId={route.accountId}
      messageId={messageId}
      {...(back ? { onBack: back } : {})}
    />
  );
}

interface MessageViewProps {
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  readonly onBack?: () => void;
}

function MessageView({ accountId, messageId, onBack }: MessageViewProps) {
  const subjectId = useId();
  const { data: message, error, refetch } = useMessage(accountId, messageId);
  const { data: mailboxes } = useMailboxes(accountId);
  const actions = useMailActions();
  useMarkReadOnView(message, (id) => {
    actions.setSeen(true, { ids: [id], silent: true });
  });
  const inbox = mailboxes?.find((mailbox) => mailbox.role === "inbox");
  const inInbox = !!message && !!inbox && message.mailboxIds.includes(inbox.id);

  let content;
  if (message) {
    content = (
      <article aria-labelledby={subjectId}>
        <MessageHeader
          message={message}
          mailboxes={mailboxes}
          subjectId={subjectId}
        />
        <MessageBody accountId={accountId} message={message} />
        <AttachmentList message={message} />
      </article>
    );
  } else if (error) {
    content = (
      <p className="p-6 text-sm text-zinc-600 dark:text-zinc-400">
        {isMailError(error, "not-found")
          ? "This message no longer exists."
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
    content = <ReaderSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="group"
        aria-label="Message actions"
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
        {message && (
          <MailActionButtons
            actions={actions}
            message={message}
            archivable={inInbox}
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
  return (
    <div
      aria-busy="true"
      aria-label="Loading message"
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
