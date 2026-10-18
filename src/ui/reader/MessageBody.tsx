import { useMemo } from "react";
import type { AccountId } from "../../core/ids";
import type { Message } from "../../core/model";
import { useInlineImages } from "../../data/hooks";
import { buildMailDocument } from "../../security/mailDocument";
import { sanitizeMailHtml } from "../../security/sanitize";
import { useUi } from "../../state/context";
import { loadsRemoteImages } from "../../state/settings";
import { Icon } from "../common/Icon";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import { useT } from "../../i18n/context";

/** Props of {@link MessageBody}. */
export interface MessageBodyProps {
  readonly accountId: AccountId;
  readonly message: Message;
}

/**
 * The message content: sanitized HTML in a sandboxed iframe, or plain text.
 * Remote content stays blocked until the user allows it for this message
 * (or the settings allow it: always, or for trusted senders).
 */
export function MessageBody({ accountId, message }: MessageBodyProps) {
  const t = useT();
  const html = message.body.html;
  const sanitized = useMemo(
    () => (html === undefined ? undefined : sanitizeMailHtml(html)),
    [html],
  );
  const { data: inlineImages } = useInlineImages(accountId, message);
  const sender = message.from?.address;
  const allowed = useUi(
    (state) =>
      state.remoteContentAllowed.has(message.id) ||
      loadsRemoteImages(state.settings, sender),
  );
  const allowRemoteContent = useUi((state) => state.allowRemoteContent);
  const trustSender = useUi((state) => state.trustSender);
  const offerTrust = useUi(
    (state) => state.settings.remoteImages === "trusted",
  );

  const srcDoc = useMemo(
    () =>
      sanitized
        ? buildMailDocument(sanitized.html, {
            allowRemoteContent: allowed,
            ...(inlineImages ? { inlineImages } : {}),
          })
        : undefined,
    [sanitized, allowed, inlineImages],
  );

  if (sanitized && srcDoc !== undefined) {
    return (
      <>
        {sanitized.hasRemoteContent && !allowed && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-700 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <Icon name="image" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t.reader.remoteBlocked}</span>
            <button
              type="button"
              onClick={() => {
                allowRemoteContent(message.id);
              }}
              className="rounded-md px-2 py-1 font-medium text-blue-700 hover:bg-zinc-200 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            >
              {t.reader.loadImages}
            </button>
            {offerTrust && sender && (
              <button
                type="button"
                onClick={() => {
                  trustSender(sender);
                }}
                className="min-w-0 truncate rounded-md px-2 py-1 font-medium text-blue-700 hover:bg-zinc-200 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
              >
                {t.reader.alwaysFrom(sender)}
              </button>
            )}
          </div>
        )}
        <SafeHtmlFrame
          srcDoc={srcDoc}
          title={t.reader.frameTitle(message.subject || t.common.noSubject)}
        />
      </>
    );
  }

  if (message.body.text !== undefined) {
    return (
      <div className="px-4 py-4 text-sm leading-relaxed break-words whitespace-pre-wrap sm:px-6">
        {message.body.text}
      </div>
    );
  }

  return (
    <p className="px-6 py-4 text-sm text-zinc-500 italic">
      {t.reader.noContent}
    </p>
  );
}
