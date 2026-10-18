/**
 * What a composer edits, and how that becomes a draft. Provider-agnostic;
 * the HTML helpers need a browser DOM.
 */
import { isValidAddress } from "../core/addresses";
import type {
  DraftInput,
  OutgoingAttachment,
  Threading,
} from "../core/compose";
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
  /** Files, and inline images (referenced from the text or quote as `cid:`). */
  readonly attachments: readonly OutgoingAttachment[];
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
 * inline images go along only while the text or quote still shows them.
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
    attachments: sentAttachments(content, html),
    ...(content.threading ? { threading: content.threading } : {}),
  };
}

/** The attachments that go out: files, and inline images `html` shows. */
function sentAttachments(
  content: ComposerContent,
  html: string,
): OutgoingAttachment[] {
  return content.attachments.filter(
    (part) =>
      part.contentId === undefined || html.includes(`cid:${part.contentId}`),
  );
}

/** Bytes of attachments the mail would carry (each save uploads them again). */
export function sentBytes(content: ComposerContent): number {
  const { html } = mailBody(content.body, content.quote);
  return sentAttachments(content, html).reduce(
    (sum, part) => sum + part.size,
    0,
  );
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

/**
 * A file of your own as an attachment; `inline` makes it an inline image
 * (with a new Content-ID) for the text.
 */
export function attachmentFromFile(
  file: File,
  inline: boolean,
): OutgoingAttachment {
  const id = crypto.randomUUID();
  return {
    id,
    filename: file.name || (inline ? "image.png" : "attachment"),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    content: file,
    ...(inline ? { contentId: `${id}@action0` } : {}),
  };
}
