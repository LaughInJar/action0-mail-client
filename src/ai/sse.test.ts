// @vitest-environment node
import { describe, expect, it } from "vitest";
import { streamOf } from "../test/aiStreams";
import { sseEvents, type SseEvent } from "./sse";

async function events(pieces: readonly string[]): Promise<SseEvent[]> {
  const found: SseEvent[] = [];
  for await (const event of sseEvents(streamOf(pieces))) found.push(event);
  return found;
}

describe("sseEvents", () => {
  it("reads events with names, several data lines and comments", async () => {
    expect(
      await events([
        ": keep-alive\n\nevent: delta\ndata: one\ndata: two\n\ndata:{}\n\n",
      ]),
    ).toEqual([{ event: "delta", data: "one\ntwo" }, { data: "{}" }]);
  });

  it("puts lines back together across pieces, \\r\\n included", async () => {
    expect(
      await events(["data: hel", "lo\r", "\n\r\nda", "ta: ü", "\n\n"]),
    ).toEqual([{ data: "hello" }, { data: "ü" }]);
  });

  it("splits multi-byte characters correctly", async () => {
    const bytes = new TextEncoder().encode("data: Grüße\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const found: SseEvent[] = [];
    for await (const event of sseEvents(stream)) found.push(event);
    expect(found).toEqual([{ data: "Grüße" }]);
  });

  it("gives the last event even without a blank line after it", async () => {
    expect(await events(["data: last"])).toEqual([{ data: "last" }]);
  });

  it("cancels the stream when the reader stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of sseEvents(stream)) {
      expect(event.data).toBe("x");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
