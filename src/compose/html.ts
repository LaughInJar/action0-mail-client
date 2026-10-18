/**
 * HTML helpers for outgoing mail: turning editor output into mail HTML and
 * a plain-text version. Browser-only (uses DOMParser).
 */

/** Escapes text for use in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text as HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p></p>"))
    .join("");
}

/**
 * Editor HTML as mail HTML. Paragraphs become `<div>`s and empty ones
 * `<div><br></div>`, like Gmail writes them, so the spacing recipients see
 * matches the editor (which shows paragraphs without margins).
 */
export function editorHtmlToMail(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );
  // Big pictures shrink to the recipient's window.
  for (const image of Array.from(doc.body.querySelectorAll("img")))
    image.setAttribute("style", "max-width:100%");
  for (const paragraph of Array.from(doc.body.querySelectorAll("p"))) {
    const div = doc.createElement("div");
    div.append(...Array.from(paragraph.childNodes));
    if (div.textContent === "" && !div.querySelector("img, br"))
      div.append(doc.createElement("br"));
    paragraph.replaceWith(div);
  }
  return doc.body.innerHTML;
}

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
const SKIPPED = new Set(["head", "style", "script", "title", "template"]);

/**
 * A readable plain-text version of mail HTML: blocks on their own lines,
 * `- ` and `1. ` list items, links as `text (url)`, quotes with `> `.
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: string[] = [];
  let line = "";
  const breakLine = () => {
    lines.push(line.replace(/[ \t]+$/, ""));
    line = "";
  };
  const endBlock = () => {
    if (line.trim() !== "") breakLine();
    else line = "";
  };

  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = pre
        ? (node.textContent ?? "")
        : (node.textContent ?? "").replace(/\s+/g, " ");
      if (pre) {
        const [first = "", ...rest] = text.split("\n");
        line += first;
        for (const next of rest) {
          breakLine();
          line = next;
        }
      } else if (!(text === " " && (line === "" || line.endsWith(" ")))) {
        line += line === "" ? text.trimStart() : text;
      }
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return;
    if (tag === "br") {
      breakLine();
      return;
    }
    if (tag === "img") {
      const alt = node.getAttribute("alt");
      if (alt) line += `[${alt}]`;
      return;
    }
    if (tag === "blockquote") {
      endBlock();
      const inner = htmlToText(node.innerHTML);
      for (const quoted of inner.split("\n"))
        lines.push(quoted ? `> ${quoted}` : ">");
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) endBlock();
    if (tag === "li") {
      const parent = node.parentElement;
      const ordered = parent?.tagName.toLowerCase() === "ol";
      const index = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
      line += ordered ? `${String(index)}. ` : "- ";
    }
    if (tag === "hr") {
      lines.push("---");
      return;
    }
    for (const child of Array.from(node.childNodes))
      walk(child, pre || tag === "pre");
    if (tag === "a") {
      const href = node.getAttribute("href") ?? "";
      const text = node.textContent.trim();
      if (
        /^(https?|mailto):/i.test(href) &&
        href.replace(/^mailto:/i, "") !== text
      )
        line += ` (${href.replace(/^mailto:/i, "")})`;
    }
    if (tag === "td" || tag === "th") line += " ";
    if (block) endBlock();
  };

  walk(doc.body, false);
  if (line.trim() !== "") breakLine();
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
