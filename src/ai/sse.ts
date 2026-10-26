/**
 * Server-sent events (the `text/event-stream` format), read from a
 * streaming response body: how every service streams its answer.
 */

/** One event: its name (if it has one) and its data lines joined. */
export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/**
 * The events of a stream, as they arrive. Stopping early (`break`, an
 * error) cancels the stream, which ends the request.
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = (): SseEvent | undefined => {
    const done =
      data.length > 0
        ? { ...(event === undefined ? {} : { event }), data: data.join("\n") }
        : undefined;
    event = undefined;
    data = [];
    return done;
  };
  const take = (line: string) => {
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      // A \r at the end may be half of a \r\n.
      const held = !done && buffer.endsWith("\r") ? "\r" : "";
      const lines = buffer
        .slice(0, buffer.length - held.length)
        .split(/\r\n|\r|\n/);
      // The last piece may be half a line.
      buffer = done ? "" : (lines.pop() ?? "") + held;
      for (const line of lines) {
        if (line !== "") {
          take(line);
          continue;
        }
        const next = dispatch();
        if (next) yield next;
      }
      if (done) break;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
