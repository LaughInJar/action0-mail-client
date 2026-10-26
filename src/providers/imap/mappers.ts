/** The bridge's JSON as domain values, and its errors as `MailError`s. */
import {
  isMailServerError,
  type MailServerError,
} from "../../accounts/mailServer";
import { parseInvitation } from "../../core/calendar";
import { MailError } from "../../core/errors";
import {
  asAttachmentId,
  asMailboxId,
  asMessageId,
  asThreadId,
} from "../../core/ids";
import type {
  EmailAddress,
  Mailbox,
  Message,
  MessageSummary,
  ThreadSummary,
} from "../../core/model";
import { parseListUnsubscribe } from "../../core/unsubscribe";
import type {
  ImapAddress,
  ImapMailbox,
  ImapMessage,
  ImapSummary,
  ImapThread,
} from "./bridge";

const address = ({ name, address: mail }: ImapAddress): EmailAddress =>
  name ? { name, address: mail } : { address: mail };

export function toMailbox(mailbox: ImapMailbox): Mailbox {
  return {
    id: asMailboxId(mailbox.id),
    name: mailbox.name,
    ...(mailbox.parentId === undefined
      ? {}
      : { parentId: asMailboxId(mailbox.parentId) }),
    kind: mailbox.kind,
    ...(mailbox.role === undefined ? {} : { role: mailbox.role }),
    selectable: mailbox.selectable,
    hidden: mailbox.hidden,
    assignable: mailbox.assignable,
    ...(mailbox.counts ? { counts: mailbox.counts } : {}),
  };
}

export function toSummary(summary: ImapSummary): MessageSummary {
  return {
    id: asMessageId(summary.id),
    threadId: asThreadId(summary.threadId),
    mailboxIds: summary.mailboxIds.map(asMailboxId),
    ...(summary.from ? { from: address(summary.from) } : {}),
    to: summary.to.map(address),
    subject: summary.subject,
    snippet: summary.snippet,
    receivedAt: summary.receivedAt,
    flags: summary.flags,
    hasAttachments: summary.hasAttachments,
  };
}

export function toThread(thread: ImapThread): ThreadSummary {
  return {
    id: asThreadId(thread.id),
    messages: thread.messages.map(toSummary),
  };
}

export function toMessage(message: ImapMessage): Message {
  const unsubscribe = parseListUnsubscribe(
    message.listUnsubscribe,
    message.listUnsubscribePost,
  );
  const invitation =
    message.calendar === undefined
      ? undefined
      : parseInvitation(message.calendar);
  return {
    ...toSummary(message),
    cc: message.cc.map(address),
    bcc: message.bcc.map(address),
    replyTo: message.replyTo.map(address),
    ...(message.internetMessageId === undefined
      ? {}
      : { internetMessageId: message.internetMessageId }),
    references: message.references,
    ...(unsubscribe ? { unsubscribe } : {}),
    ...(invitation ? { invitation } : {}),
    body: message.body,
    attachments: message.attachments.map((part) => ({
      id: asAttachmentId(part.id),
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.size,
      ...(part.contentId === undefined ? {} : { contentId: part.contentId }),
    })),
  };
}

/**
 * A bridge failure as a `MailError` (`auth`: the session needs a new
 * password). `service` names the server, `name` a folder being created.
 */
export function toMailError(
  error: unknown,
  context: { readonly service: string; readonly name?: string },
): unknown {
  if (!isMailServerError(error)) return error;
  const failure: MailServerError = error;
  const options = { cause: failure };
  switch (failure.kind) {
    case "auth":
      return new MailError("auth-required", failure.message, {
        ...options,
        reason: "signInAgain",
        params: { provider: context.service },
      });
    case "unreachable":
    case "tls":
    case "untrusted":
      return new MailError("network", failure.message, {
        ...options,
        reason: "unreachable",
        params: { service: context.service },
      });
    case "notFound":
      return new MailError("not-found", failure.message, options);
    case "exists":
      return new MailError("provider", failure.message, {
        ...options,
        reason: "folderExists",
        params: { name: context.name ?? "" },
      });
    case "tooBig":
      return new MailError("provider", failure.message, {
        ...options,
        reason: "mailTooBig",
      });
    case "rejected":
      return new MailError("provider", failure.message, {
        ...options,
        reason: "mailRejected",
        params: { detail: failure.message },
      });
    case "oauth":
      return new MailError("auth-required", failure.message, {
        ...options,
        reason: "signInFailed",
        params: { provider: context.service, detail: failure.message },
      });
    case "server":
      return new MailError("provider", failure.message, options);
  }
}
