import type {
  AutoReply,
  FilterCapabilities,
  MailFilter,
} from "../../core/filters";
import type { MailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import type { I18n } from "../../i18n/context";
import { formatBytes } from "../common/format";

/** A filter in one line: what it looks for, and what it does. */
export interface FilterSummary {
  readonly conditions: string;
  readonly actions: string;
}

/**
 * The summary of a filter in the account's words (labels or categories),
 * e.g. "From news@shop.at" and "skip the Inbox, label Shopping".
 */
export function describeFilter(
  filter: MailFilter,
  capabilities: FilterCapabilities,
  mailboxes: readonly Mailbox[],
  t: I18n,
): FilterSummary {
  const f = t.filters;
  const { conditions: c, actions: a } = filter;
  const quoted = (values: readonly string[]) =>
    values.map((value) => `“${value}”`).join(f.or);
  const plain = (values: readonly string[]) => values.join(f.or);
  const nameOf = (id: MailboxId) =>
    mailboxes.find((mailbox) => mailbox.id === id)?.name ?? id;
  const categories = !capabilities.actions.includes("skipInbox");
  const conditions = [
    ...(c.from.length > 0 ? [f.summaryFrom(plain(c.from))] : []),
    ...(c.to.length > 0 ? [f.summaryTo(plain(c.to))] : []),
    ...(c.subject.length > 0 ? [f.summarySubject(quoted(c.subject))] : []),
    ...(c.words.length > 0 ? [f.summaryWords(quoted(c.words))] : []),
    ...(c.notWords.length > 0 ? [f.summaryNotWords(quoted(c.notWords))] : []),
    ...(c.hasAttachment ? [f.summaryAttachment] : []),
    ...(c.size
      ? [
          (c.size.compare === "larger" ? f.summaryLarger : f.summarySmaller)(
            formatBytes(c.size.bytes, t.locale),
          ),
        ]
      : []),
  ];
  const actions = [
    ...(a.skipInbox ? [f.summarySkipInbox] : []),
    ...(a.moveTo === undefined ? [] : [f.summaryMoveTo(nameOf(a.moveTo))]),
    ...a.labels.map((id) =>
      (categories ? f.summaryCategory : f.summaryLabel)(nameOf(id)),
    ),
    ...(a.markRead ? [f.summaryMarkRead] : []),
    ...(a.star ? [f.summaryStar] : []),
    ...(a.forwardTo.length > 0
      ? [f.summaryForward(a.forwardTo.join(", "))]
      : []),
    ...(a.trash ? [f.summaryTrash] : []),
    ...(a.neverSpam ? [f.summaryNeverSpam] : []),
    ...(a.stop ? [f.summaryStop] : []),
    ...(filter.more ? [f.andMore] : []),
  ];
  return {
    conditions: conditions.join(" · "),
    actions: actions.join(", "),
  };
}

/** Splits what was typed into a field: commas separate values. */
export function valuesOf(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** A field's text for its values. */
export function textOf(values: readonly string[]): string {
  return values.join(", ");
}

/** "Off", "On", "On from … to …" for an automatic reply. */
export function autoReplyStatus(reply: AutoReply, t: I18n): string {
  const f = t.filters;
  if (!reply.enabled) return f.autoReplyOff;
  const day = (value: string) => {
    const [year = 0, month = 1, date = 1] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(t.locale, { dateStyle: "medium" }).format(
      new Date(year, month - 1, date),
    );
  };
  if (reply.start && reply.end)
    return f.autoReplyBetween(day(reply.start), day(reply.end));
  if (reply.start) return f.autoReplyFrom(day(reply.start));
  if (reply.end) return f.autoReplyUntil(day(reply.end));
  return f.autoReplyOn;
}
