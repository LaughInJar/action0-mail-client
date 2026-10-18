import { Fragment, type ReactNode } from "react";

/** Renders the text inside a tag; `<name/>` gets an empty string. */
export type TagRenderer = (children: string) => ReactNode;

const DEFAULT_TAGS: Readonly<Record<string, TagRenderer>> = {
  em: (children) => <em>{children}</em>,
  code: (children) => <code className="text-xs">{children}</code>,
};

const TAG = /<(\w+)\/>|<(\w+)>(.*?)<\/\2>/gs;

/**
 * A translated text with simple tags, so a sentence keeps its links and
 * emphasis in any word order: "Choose <em>External</em>", "<link>the People
 * API</link>", "<origin/>". Tags don't nest; `em` and `code` work without
 * being passed, unknown tags show as they are.
 */
export function RichText({
  text,
  tags = {},
}: {
  text: string;
  tags?: Readonly<Record<string, TagRenderer>>;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const name = match[1] ?? match[2] ?? "";
    const render = tags[name] ?? DEFAULT_TAGS[name];
    parts.push(
      <Fragment key={match.index}>
        {render ? render(match[3] ?? "") : match[0]}
      </Fragment>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
