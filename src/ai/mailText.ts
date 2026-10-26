/**
 * Mail as the AI reads it: plain text with the headers that matter (times
 * in the user's time zone), never attachments, images or text the sender
 * hid. Conversations leave out the
 * quoted earlier mail each reply carries, and long ones keep only the
 * newest messages that fit.
 */
import { formatAddress } from "../core/addresses";
import type { EmailAddress, Message } from "../core/model";
import { htmlToText } from "../compose/html";
import { sanitizeMailHtml } from "../security/sanitize";

/** The mail as text, and how many of its messages it holds. */
export interface MailText {
  readonly text: string;
  readonly included: number;
  readonly total: number;
}

/** How many characters of mail the AI reads at most. */
export const MAIL_BUDGET = {
  /** Online services read a lot at once. */
  online: 100_000,
  /** Local models often read only a few thousand words. */
  local: 12_000,
} as const;

/** Inline styles that hide an element (preheaders, invisible text). */
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$)|font-size\s*:\s*0(px|pt|em|rem|%)?\s*(;|$)|max-height\s*:\s*0(px)?\s*(;|$)|mso-hide\s*:\s*all/i;

/** The quoted earlier mail of replies (Gmail, Apple Mail, Thunderbird, Outlook). */
const QUOTES = [
  ".gmail_quote",
  ".gmail_extra",
  'blockquote[type="cite"]',
  ".moz-cite-prefix",
  "#divRplyFwdMsg",
  "#divRplyFwdMsg ~ *",
  "#appendonsend ~ *",
].join(", ");

/**
 * The messages (oldest first) as text: the newest ones that fit into
 * `budget` characters, oldest first again. The newest is always included,
 * shortened if it alone is too long.
 */
export function mailText(
  messages: readonly Message[],
  budget: number,
): MailText {
  const thread = messages.length > 1;
  const blocks: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const block = messageBlock(message, thread);
    if (blocks.length > 0 && used + block.length > budget) break;
    blocks.unshift(
      block.length > budget ? `${block.slice(0, budget)}\n[…]` : block,
    );
    used += block.length;
  }
  const total = messages.length;
  const text = thread
    ? blocks
        .map(
          (block, index) =>
            `--- Message ${String(total - blocks.length + index + 1)} of ${String(total)} ---\n${block}`,
        )
        .join("\n\n")
    : (blocks[0] ?? "");
  return { text, included: blocks.length, total };
}

/**
 * A time as the user's clock shows it, with the weekday and the offset
 * ("Fri 2026-10-16 20:59 (UTC+02:00)"), so the AI can work out "Friday"
 * and "tomorrow" the way the user means them.
 */
export function localTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)})`;
}

function messageBlock(message: Message, dropQuotes: boolean): string {
  const header = [
    message.from && `From: ${formatAddress(message.from)}`,
    addresses("To", message.to),
    addresses("Cc", message.cc),
    `Date: ${localTime(new Date(message.receivedAt))}`,
    `Subject: ${message.subject}`,
  ].filter(Boolean);
  return `${header.join("\n")}\n\n${bodyText(message, dropQuotes)}`;
}

function addresses(
  name: string,
  list: readonly EmailAddress[],
): string | undefined {
  return list.length > 0
    ? `${name}: ${list.map(formatAddress).join(", ")}`
    : undefined;
}

/**
 * The text the reader shows: the HTML (sanitized, without hidden elements)
 * if there is any, else the text part. Text parts are often a stub ("view
 * this mail in your browser") next to the real HTML.
 */
export function bodyText(message: Message, dropQuotes = false): string {
  const { html, text } = message.body;
  const shown = html === undefined ? "" : visibleText(html, dropQuotes);
  if (shown.trim() !== "" || text === undefined) return shown;
  return dropQuotes ? withoutQuotedLines(text) : text.trim();
}

/**
 * Mail HTML as the text a reader sees: sanitized, without hidden elements
 * (and without quoted earlier mail, if asked).
 */
export function visibleText(html: string, dropQuotes = false): string {
  const doc = new DOMParser().parseFromString(
    sanitizeMailHtml(html).html,
    "text/html",
  );
  for (const element of Array.from(doc.body.querySelectorAll("*")))
    if (
      element.isConnected &&
      (element.hasAttribute("hidden") ||
        HIDDEN_STYLE.test(element.getAttribute("style") ?? ""))
    )
      element.remove();
  if (dropQuotes)
    for (const quote of Array.from(doc.body.querySelectorAll(QUOTES)))
      quote.remove();
  return htmlToText(doc.body.innerHTML);
}

/** Plain text without `>` lines and the "On …, … wrote:" line above them. */
function withoutQuotedLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = lines.filter((line) => !line.startsWith(">"));
  // The attribution line ends with a colon right before the quote.
  const quoteStart = lines.findIndex((line) => line.startsWith(">"));
  if (quoteStart > 0) {
    const attribution = lines
      .slice(0, quoteStart)
      .findLastIndex((line) => line.trim() !== "");
    const line = lines[attribution];
    if (line?.trimEnd().endsWith(":")) kept.splice(kept.indexOf(line), 1);
  }
  return kept.join("\n").trim();
}
