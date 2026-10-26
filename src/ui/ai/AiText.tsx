import type { ReactNode } from "react";

type Block =
  | { readonly kind: "paragraph"; readonly lines: string[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: string[];
    };

const LIST_ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;

/** Paragraphs and lists of plain text, as the AI is asked to write. */
function textBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | undefined;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    // Headings are shown as plain lines.
    const line = raw.replace(/^#{1,6}\s+/, "");
    const item = LIST_ITEM.exec(line);
    if (line.trim() === "") {
      open = undefined;
    } else if (item) {
      const ordered = item[2] !== undefined;
      if (open?.kind !== "list" || open.ordered !== ordered) {
        open = { kind: "list", ordered, items: [] };
        blocks.push(open);
      }
      open.items.push(item[3] ?? "");
    } else if (open?.kind === "paragraph") {
      open.lines.push(line);
    } else {
      open = { kind: "paragraph", lines: [line] };
      blocks.push(open);
    }
  }
  return blocks;
}

/** `**bold**` as <strong>; everything else stays text. */
function inline(text: string): ReactNode[] {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((part, index) =>
      index % 2 === 1 ? <strong key={index}>{part}</strong> : part,
    );
}

/**
 * An AI's answer: paragraphs, lists and bold, built as elements, never as
 * HTML (the answer may repeat whatever a mail said).
 */
export function AiText({ text }: { readonly text: string }) {
  return (
    <div className="space-y-2 break-words">
      {textBlocks(text).map((block, index) => {
        if (block.kind === "paragraph")
          return (
            <p key={index}>
              {block.lines.map((line, at) => (
                <span key={at}>
                  {at > 0 && <br />}
                  {inline(line)}
                </span>
              ))}
            </p>
          );
        const items = block.items.map((item, at) => (
          <li key={at}>{inline(item)}</li>
        ));
        return block.ordered ? (
          <ol key={index} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        );
      })}
    </div>
  );
}
