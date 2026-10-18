import type { ReactNode } from "react";
import type { EmailAddress, Mailbox, Message } from "../../core/model";
import { displayName, formatFullDate } from "../common/format";
import { Icon } from "../common/Icon";
import { useT } from "../../i18n/context";

/** Props of {@link MessageHeader}. */
export interface MessageHeaderProps {
  readonly message: Message;
  readonly mailboxes: readonly Mailbox[] | undefined;
  /** DOM id of the subject heading; without it there is no subject (in a conversation, it's shown once on top). */
  readonly subjectId?: string;
  /** Shown after the date (e.g. a conversation message's own buttons). */
  readonly trailing?: ReactNode;
  /** For mailing lists: unsubscribe (asks first), or whether that's done. */
  readonly unsubscribe?: {
    readonly done: boolean;
    readonly onClick: () => void;
  };
}

/** Subject, label chips, sender (with Unsubscribe for lists), recipients and date. */
export function MessageHeader({
  message,
  mailboxes,
  subjectId,
  trailing,
  unsubscribe,
}: MessageHeaderProps) {
  const t = useT();
  const labels = (mailboxes ?? []).filter(
    (mailbox) =>
      mailbox.kind === "label" &&
      mailbox.role === undefined &&
      message.mailboxIds.includes(mailbox.id),
  );

  return (
    <header
      className={`space-y-3 px-4 sm:px-6 ${subjectId === undefined ? "pt-3 pb-2" : "border-b border-zinc-200 py-4 dark:border-zinc-800"}`}
    >
      {subjectId !== undefined && (
        <h1
          id={subjectId}
          className="text-lg font-semibold break-words sm:text-xl"
        >
          {message.subject || t.common.noSubject}
        </h1>
      )}
      {subjectId !== undefined && labels.length > 0 && (
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
      <div className="flex items-start gap-3">
        <Avatar address={message.from} unknown={t.common.unknownSender} />
        <div className="min-w-0 flex-1 space-y-0.5 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">
              {displayName(message.from, t.common.unknownSender)}
            </span>
            {message.from?.name && (
              <span className="min-w-0 truncate text-zinc-500">
                {message.from.address}
              </span>
            )}
            {unsubscribe &&
              (unsubscribe.done ? (
                <span className="flex items-center gap-1 self-center border border-transparent py-0.5 text-xs text-zinc-500">
                  <Icon name="check" className="size-3.5" />
                  {t.reader.unsubscribed}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={unsubscribe.onClick}
                  // Small to look at; the touch area reaches 44px.
                  className="relative self-center rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-3 pointer-coarse:before:content-['']"
                >
                  {t.reader.unsubscribe}
                </button>
              ))}
            <time
              dateTime={message.receivedAt}
              className="ml-auto shrink-0 text-xs text-zinc-500"
            >
              {formatFullDate(message.receivedAt, { locale: t.locale })}
            </time>
            {trailing && (
              <span className="-my-2 flex shrink-0 items-center self-center">
                {trailing}
              </span>
            )}
          </div>
          <AddressLine label={t.common.to} addresses={message.to} />
          <AddressLine label={t.common.cc} addresses={message.cc} />
          <AddressLine label={t.common.replyTo} addresses={message.replyTo} />
        </div>
      </div>
    </header>
  );
}

function AddressLine({
  label,
  addresses,
}: {
  label: string;
  addresses: readonly EmailAddress[];
}) {
  if (addresses.length === 0) return null;
  return (
    <p className="text-zinc-600 dark:text-zinc-400">
      <span className="text-zinc-500">{label}: </span>
      {addresses.map((address, index) => (
        <span key={`${address.address}-${index}`} title={address.address}>
          {index > 0 && ", "}
          {displayName(address, "")}
        </span>
      ))}
    </p>
  );
}

const AVATAR_COLORS = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-violet-600",
  "bg-cyan-600",
  "bg-fuchsia-600",
  "bg-lime-700",
];

function Avatar({
  address,
  unknown,
}: {
  address: EmailAddress | undefined;
  unknown: string;
}) {
  const name = displayName(address, unknown);
  const key = address?.address ?? name;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  const color =
    AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "bg-zinc-500";
  return (
    <span
      aria-hidden="true"
      className={`grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white ${color}`}
    >
      {(/\p{L}|\p{N}/u.exec(name)?.[0] ?? "?").toUpperCase()}
    </span>
  );
}
