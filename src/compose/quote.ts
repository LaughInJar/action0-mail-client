/**
 * Quoting the original in replies and forwards. The quote sits in Gmail's
 * own marker (`<div class="gmail_quote">`), so Gmail collapses it too and a
 * reopened draft can be split into what the user wrote and the quote.
 */
import { formatAddress } from "../core/addresses";
import type { EmailAddress, Message } from "../core/model";
import { sanitizeMailHtml } from "../security/sanitize";
import { escapeHtml, htmlToText } from "./html";

/** The quoted original: HTML for the mail, text for its plain version. */
export interface Quote {
  readonly html: string;
  readonly text: string;
}

const QUOTE_CLASS = "gmail_quote";
const BLOCKQUOTE_STYLE =
  "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex";

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

const addressList = (list: readonly EmailAddress[]) =>
  list.map(formatAddress).join(", ");

/**
 * The original's body as HTML for quoting: sanitized, with its `<style>`
 * blocks so the layout survives. Replies drop inline (`cid:`) images,
 * because they don't carry the original's parts; forwards keep them.
 */
function originalHtml(original: Message, keepInlineImages: boolean): string {
  const { html, text } = original.body;
  if (html === undefined)
    return `<div style="white-space:pre-wrap">${escapeHtml(text ?? "")}</div>`;
  const doc = new DOMParser().parseFromString(
    sanitizeMailHtml(html).html,
    "text/html",
  );
  if (!keepInlineImages)
    for (const image of Array.from(doc.querySelectorAll('img[src^="cid:"]')))
      image.remove();
  const styles = Array.from(doc.querySelectorAll("head style"))
    .map((style) => style.outerHTML)
    .join("");
  return styles + doc.body.innerHTML;
}

function originalText(original: Message): string {
  const { html, text } = original.body;
  return text ?? (html === undefined ? "" : htmlToText(html));
}

const senderLine = (original: Message) =>
  original.from ? formatAddress(original.from) : "Unknown sender";

/** "On <date>, <sender> wrote:" and the original in a blockquote. */
export function replyQuote(original: Message): Quote {
  const date = dateFormat.format(new Date(original.receivedAt));
  const attribution = `On ${date}, ${senderLine(original)} wrote:`;
  return {
    html:
      `<div class="${QUOTE_CLASS}"><div class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
      `<blockquote class="${QUOTE_CLASS}" style="${BLOCKQUOTE_STYLE}">${originalHtml(original, false)}</blockquote></div>`,
    text: [
      attribution,
      ...originalText(original)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">")),
    ].join("\n"),
  };
}

/** The "Forwarded message" header and the original. */
export function forwardQuote(original: Message): Quote {
  const fields: [string, string][] = [
    ["From", senderLine(original)],
    ["Date", dateFormat.format(new Date(original.receivedAt))],
    ["Subject", original.subject],
    ["To", addressList(original.to)],
    ...(original.cc.length > 0
      ? [["Cc", addressList(original.cc)] as [string, string]]
      : []),
  ];
  const heading = "---------- Forwarded message ---------";
  return {
    html:
      `<div class="${QUOTE_CLASS}"><div class="gmail_attr">${heading}<br>` +
      fields
        .map(([name, value]) => `${name}: ${escapeHtml(value)}<br>`)
        .join("") +
      `</div><br>${originalHtml(original, true)}</div>`,
    text: [
      heading,
      ...fields.map(([name, value]) => `${name}: ${value}`),
      "",
      originalText(original),
    ].join("\n"),
  };
}

/**
 * Splits a draft's HTML into what the user wrote and the quote (from the
 * first top-level quote marker on).
 */
export function splitQuote(html: string): {
  readonly body: string;
  readonly quote?: Quote;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const marker = Array.from(
    doc.body.querySelectorAll<HTMLElement>(`div.${QUOTE_CLASS}`),
  ).find((element) => !element.parentElement?.closest(`.${QUOTE_CLASS}`));
  if (!marker) return { body: doc.body.innerHTML };

  // The marker and everything after it (at its level and above) is quote.
  const quote = doc.createElement("div");
  let node: Node | null = marker;
  while (node && node !== doc.body) {
    const parent: Node | null = node.parentNode;
    let next: Node | null = node.nextSibling;
    const moving: Node[] = [];
    if (node === marker) moving.push(node);
    while (next) {
      moving.push(next);
      next = next.nextSibling;
    }
    quote.append(...moving);
    node = parent;
  }
  // Trailing line breaks between the text and the quote belong to neither.
  let last = doc.body.lastChild;
  while (
    last &&
    (last.nodeName === "BR" ||
      (last.nodeType === Node.TEXT_NODE && !last.textContent?.trim()))
  ) {
    last.remove();
    last = doc.body.lastChild;
  }
  const quoteHtml = quote.innerHTML;
  return {
    body: doc.body.innerHTML,
    quote: { html: quoteHtml, text: htmlToText(quoteHtml) },
  };
}
