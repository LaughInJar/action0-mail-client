/** Streaming answers for AI tests: bodies that arrive piece by piece. */

/** A body that delivers these pieces one after another. */
export function streamOf(
  pieces: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const piece = pieces[index++];
      if (piece === undefined) controller.close();
      else controller.enqueue(encoder.encode(piece));
    },
  });
}

/** An event with a name (`event:` line), for {@link sseResponse}. */
export class NamedEvent {
  readonly event: string;
  readonly data: unknown;

  constructor(event: string, data: unknown) {
    this.event = event;
    this.data = data;
  }
}

/**
 * A `text/event-stream` answer with these events' data (JSON unless it's
 * text); `split` delivers it in small pieces, as networks do.
 */
export function sseResponse(
  events: readonly unknown[],
  { split = false }: { readonly split?: boolean } = {},
): Response {
  const text = events
    .map((event) => {
      const named = event instanceof NamedEvent ? event : undefined;
      const data = named ? named.data : event;
      const line = typeof data === "string" ? data : JSON.stringify(data);
      return `${named ? `event: ${named.event}\n` : ""}data: ${line}\n\n`;
    })
    .join("");
  const pieces = split ? (text.match(/[\s\S]{1,7}/g) ?? []) : [text];
  return new Response(streamOf(pieces), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Everything an async iterable yields, joined. */
export async function collect(pieces: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const piece of pieces) text += piece;
  return text;
}
