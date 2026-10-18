/**
 * What a composer edits, and how that becomes a draft. Provider-agnostic;
 * the HTML helpers need a browser DOM.
 */
import { isValidAddress } from "../core/addresses";
import type { DraftInput, ForwardedPart, Threading } from "../core/compose";
import type { DraftId } from "../core/ids";
import type { EmailAddress } from "../core/model";
import { editorHtmlToMail, htmlToText } from "./html";
import type { Quote } from "./quote";

/** The editable content of a composer. */
export interface ComposerContent {
  /** Recipients as entered; invalid ones are kept so they can be fixed. */
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  /** Editor HTML: what the user wrote, without the quote. */
  readonly body: string;
  /** The quoted original of a reply or forward. */
  readonly quote?: Quote;
  /** Parts of the original that a forward carries (files and inline images). */
  readonly forwarded: readonly ForwardedPart[];
  readonly threading?: Threading;
}

/** The whole mail body: what the user wrote, then the quote. */
export function mailBody(
  body: string,
  quote: Quote | undefined,
): { readonly html: string; readonly text: string } {
  const own = editorHtmlToMail(body);
  const ownText = htmlToText(own);
  return {
    html: quote ? `${own}<br>${quote.html}` : own,
    text: quote ? `${ownText}\n\n${quote.text}`.trim() : ownText,
  };
}

const valid = (list: readonly EmailAddress[]) =>
  list.filter((address) => isValidAddress(address.address));

/**
 * The draft for this content. Invalid addresses stay in the composer only;
 * inline images go along only while the quote that shows them does.
 */
export function draftInputOf(
  content: ComposerContent,
  id?: DraftId,
): DraftInput {
  const { html, text } = mailBody(content.body, content.quote);
  return {
    ...(id === undefined ? {} : { id }),
    to: valid(content.to),
    cc: valid(content.cc),
    bcc: valid(content.bcc),
    subject: content.subject,
    html,
    text,
    forwarded: content.quote
      ? content.forwarded
      : content.forwarded.filter((part) => part.contentId === undefined),
    ...(content.threading ? { threading: content.threading } : {}),
  };
}

/** Bytes that every save of this content uploads again. */
export function forwardedBytes(content: ComposerContent): number {
  return content.forwarded.reduce((sum, part) => sum + part.size, 0);
}

/**
 * Mail HTML (from a saved draft) as editor HTML: `<div>` lines become
 * paragraphs again, `<div><br></div>` empty ones.
 */
export function mailHtmlToEditor(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );
  const blocks = "p, div, ul, ol, li, blockquote, table, h1, h2, h3, pre";
  for (const div of Array.from(doc.body.querySelectorAll("div")).reverse()) {
    if (div.querySelector(blocks)) continue;
    const paragraph = doc.createElement("p");
    const onlyBreak =
      div.childNodes.length === 1 && div.firstChild?.nodeName === "BR";
    if (!onlyBreak) paragraph.append(...Array.from(div.childNodes));
    div.replaceWith(paragraph);
  }
  return doc.body.innerHTML;
}
