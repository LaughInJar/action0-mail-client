import { memo } from "react";
import { formatListDate } from "../common/format";
import { Icon } from "../common/Icon";
import type { RowView } from "./rowView";

/** Props of {@link MessageRow}. */
export interface MessageRowProps {
  readonly domId: string;
  /** What the row shows (a message or a conversation). */
  readonly view: RowView;
  /** The cursor is on this row (it is shown in the reader). */
  readonly focused: boolean;
  /** Part of the selection the next action would apply to. */
  readonly selected: boolean;
  /** Show checkboxes (a multi-selection exists). */
  readonly selectionMode: boolean;
  /** Can be dragged onto the mailbox tree (mouse only). */
  readonly draggable: boolean;
  /** The star toggles on click (the list handles the click). */
  readonly starrable: boolean;
  /** One line instead of two (the density setting). */
  readonly compact: boolean;
}

/** One message (or conversation) in the list. Clicks are handled by the list (event delegation). */
export const MessageRow = memo(function MessageRow({
  domId,
  view,
  focused,
  selected,
  selectionMode,
  draggable,
  starrable,
  compact,
}: MessageRowProps) {
  const { unread } = view;
  const who = (
    <>
      {view.who}
      {view.draft && (
        <span className="font-normal text-red-700 dark:text-red-400">
          {view.who ? ", " : ""}Draft
        </span>
      )}
      {view.count !== undefined && (
        <span className="ml-1 text-xs font-normal text-zinc-500">
          {view.count}
          <span className="sr-only"> messages</span>
        </span>
      )}
    </>
  );
  const time = (
    <time
      dateTime={view.receivedAt}
      className={`shrink-0 text-xs tabular-nums ${unread ? "font-semibold text-blue-700 dark:text-blue-300" : "text-zinc-500"}`}
    >
      {formatListDate(view.receivedAt)}
    </time>
  );
  const subjectAndSnippet = (
    <p className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400">
      <span
        className={
          unread
            ? "font-semibold text-zinc-900 dark:text-zinc-100"
            : "text-zinc-700 dark:text-zinc-300"
        }
      >
        {view.subject || "(no subject)"}
      </span>
      {view.snippet && <> — {view.snippet}</>}
    </p>
  );
  const markers = (
    <>
      {view.hasAttachments && (
        <>
          <Icon name="paperclip" className="size-3.5 shrink-0 text-zinc-400" />
          <span className="sr-only">, has attachments</span>
        </>
      )}
      {starrable ? (
        // Clicks are handled by the list; `s` is the keyboard path.
        <span
          data-star=""
          title={view.flagged ? "Unstar (s)" : "Star (s)"}
          className={`-m-1 grid shrink-0 place-items-center p-1 ${
            view.flagged
              ? ""
              : "invisible group-hover:visible pointer-coarse:hidden"
          }`}
        >
          <Icon
            name="star"
            className={`size-3.5 ${
              view.flagged
                ? "fill-amber-400 text-amber-500"
                : "text-zinc-400 hover:text-amber-500"
            }`}
          />
        </span>
      ) : (
        view.flagged && (
          <Icon
            name="star"
            className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
          />
        )
      )}
      {view.flagged && <span className="sr-only">, starred</span>}
    </>
  );

  return (
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      data-message-id={view.id}
      draggable={draggable}
      className={[
        "group flex cursor-default gap-3 border-b border-zinc-100 px-3 select-none dark:border-zinc-800/70",
        compact
          ? "items-center py-1.5 pointer-coarse:min-h-11"
          : "py-2.5 pointer-coarse:py-3",
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
      <span
        className={`flex w-4 shrink-0 justify-center ${compact ? "" : "pt-1.5"}`}
      >
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
      {compact ? (
        <>
          <span
            className={`w-[30%] max-w-44 shrink-0 truncate text-sm ${unread ? "font-semibold" : ""}`}
          >
            {who}
          </span>
          {subjectAndSnippet}
          {markers}
          {time}
        </>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}
            >
              {who}
            </span>
            {time}
          </div>
          <div className="flex items-center gap-2">
            {subjectAndSnippet}
            {markers}
          </div>
        </div>
      )}
    </div>
  );
});
