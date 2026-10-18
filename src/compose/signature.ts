/**
 * The signature block of outgoing mail. It sits in Gmail's own marker
 * (`<div class="gmail_signature">`) between what the user wrote and the
 * quote, so a reopened draft can be split again and Gmail recognises it.
 */
import { htmlToText } from "./html";

const SIGNATURE_CLASS = "gmail_signature";

/** A signature in a composer: the address it belongs to and its HTML. */
export interface ComposerSignature {
  readonly address: string;
  /** As stored with the provider; "" for an address without one. */
  readonly html: string;
}

/** The signature as mail HTML (sent exactly as stored). */
export function signatureBlock(html: string): string {
  return `<div class="${SIGNATURE_CLASS}" data-smartmail="${SIGNATURE_CLASS}">${html}</div>`;
}

/** The signature's plain-text version. */
export function signatureText(html: string): string {
  return htmlToText(html);
}

/**
 * Splits what the user wrote (without the quote, see `splitQuote`) from a
 * signature block at its end.
 */
export function splitSignature(html: string): {
  readonly body: string;
  readonly signature?: string;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = Array.from(doc.body.children).filter((element) =>
    element.classList.contains(SIGNATURE_CLASS),
  );
  const block = blocks.at(-1);
  if (!block) return { body: html };
  const signature = block.innerHTML;
  block.remove();
  // Line breaks between the text and the signature belong to neither.
  let last = doc.body.lastChild;
  while (
    last &&
    (last.nodeName === "BR" ||
      (last.nodeType === Node.TEXT_NODE && !last.textContent?.trim()))
  ) {
    last.remove();
    last = doc.body.lastChild;
  }
  return { body: doc.body.innerHTML, signature };
}
