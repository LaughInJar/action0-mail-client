import { memo } from "react";
import type { MessageSummary } from "../../core/model";
import { displayName, displayNames, formatListDate } from "../common/format";
import { Icon } from "../common/Icon";

/** Props of {@link MessageRow}. */
export interface MessageRowProps {
  readonly domId: string;
  readonly summary: MessageSummary;
  /** The cursor is on this row (it is shown in the reader). */
  readonly focused: boolean;
  /** Part of the selection the next action would apply to. */
  readonly selected: boolean;
  /** Show checkboxes (a multi-selection exists). */
  readonly selectionMode: boolean;
  /** Show recipients instead of the sender (Sent, Drafts). */
  readonly showRecipients: boolean;
  /** Can be dragged onto the mailbox tree (mouse only). */
  readonly draggable: boolean;
  /** The star toggles on click (the list handles the click). */
  readonly starrable: boolean;
}

/** One message in the list. Clicks are handled by the list (event delegation). */
export const MessageRow = memo(function MessageRow({
  domId,
  summary,
  focused,
  selected,
  selectionMode,
  showRecipients,
  draggable,
  starrable,
}: MessageRowProps) {
  const unread = !summary.flags.seen;
  const who = showRecipients
    ? `To: ${displayNames(summary.to) || "(no recipients)"}`
    : displayName(summary.from);

  return (
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      data-message-id={summary.id}
      draggable={draggable}
      className={[
        "group flex cursor-default gap-3 border-b border-zinc-100 px-3 py-2.5 select-none dark:border-zinc-800/70 pointer-coarse:py-3",
        selected && selectionMode
          ? "bg-blue-100 dark:bg-blue-500/25"
          : focused
            ? "bg-blue-50 dark:bg-blue-500/15"
            : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
        focused
          ? "in-focus-visible:ring-2 in-focus-visible:ring-blue-500 in-focus-visible:ring-inset"
          : "",
      ].join(" ")}
    >
      <span className="flex w-4 shrink-0 justify-center pt-1.5">
        {selectionMode ? (
          <span
            className={`grid size-4 place-items-center rounded border ${selected ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-400 dark:border-zinc-500"}`}
          >
            {selected && <Icon name="check" className="size-3" />}
          </span>
        ) : (
          unread && (
            <span className="size-2 rounded-full bg-blue-600 dark:bg-blue-400">
              <span className="sr-only">Unread, </span>
            </span>
          )
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}
          >
            {who}
          </span>
          <time
            dateTime={summary.receivedAt}
            className={`shrink-0 text-xs tabular-nums ${unread ? "font-semibold text-blue-700 dark:text-blue-300" : "text-zinc-500"}`}
          >
            {formatListDate(summary.receivedAt)}
          </time>
        </div>
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400">
            <span
              className={
                unread
                  ? "font-semibold text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-700 dark:text-zinc-300"
              }
            >
              {summary.subject || "(no subject)"}
            </span>
            {summary.snippet && <> — {summary.snippet}</>}
          </p>
          {summary.hasAttachments && (
            <>
              <Icon
                name="paperclip"
                className="size-3.5 shrink-0 text-zinc-400"
              />
              <span className="sr-only">, has attachments</span>
            </>
          )}
          {starrable ? (
            // Clicks are handled by the list; `s` is the keyboard path.
            <span
              data-star=""
              title={summary.flags.flagged ? "Unstar (s)" : "Star (s)"}
              className={`-m-1 grid shrink-0 place-items-center p-1 ${
                summary.flags.flagged
                  ? ""
                  : "invisible group-hover:visible pointer-coarse:hidden"
              }`}
            >
              <Icon
                name="star"
                className={`size-3.5 ${
                  summary.flags.flagged
                    ? "fill-amber-400 text-amber-500"
                    : "text-zinc-400 hover:text-amber-500"
                }`}
              />
            </span>
          ) : (
            summary.flags.flagged && (
              <Icon
                name="star"
                className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
              />
            )
          )}
          {summary.flags.flagged && <span className="sr-only">, starred</span>}
        </div>
      </div>
    </div>
  );
});
