import { describe, expect, it, vi } from "vitest";
import { createNativeFetch, toResponse, type Invoke } from "./nativeFetch";

/** The native side's answer: `[u32 meta length][meta][body]`. */
function framed(
  meta: { status: number; statusText: string; headers: [string, string][] },
  body = "",
): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const bytes = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + json.length + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bytes, 4 + json.length);
  return out.buffer;
}

interface Call {
  readonly command: string;
  readonly args: unknown;
  readonly headers: Record<string, string> | undefined;
}

function setup(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const invoke = vi.fn(
    (
      command: string,
      args?: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      const call = { command, args, headers: options?.headers };
      calls.push(call);
      return answer(call);
    },
  ) as unknown as Invoke;
  return { fetch: createNativeFetch(invoke), calls };
}

const meta = (call: Call) =>
  JSON.parse(decodeURIComponent(call.headers?.["x-a0-request"] ?? "")) as {
    id: number;
    method: string;
    url: string;
    headers: [string, string][];
  };

describe("native fetch", () => {
  it("sends method, URL, headers and the body as raw bytes", async () => {
    const { fetch, calls } = setup(() =>
      Promise.resolve(
        framed(
          {
            status: 200,
            statusText: "OK",
            headers: [
              ["content-type", "application/json"],
              ["location", "https://upload.example/session"],
            ],
          },
          '{"ok":true}',
        ),
      ),
    );
    const response = await fetch("https://gmail.googleapis.com/x?y=1", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "text/plain" },
      body: new Blob(["héllo"]),
    });
    const [call] = calls;
    expect(call?.command).toBe("net_fetch");
    expect(new TextDecoder().decode(call?.args as Uint8Array)).toBe("héllo");
    expect(meta(call!)).toMatchObject({
      method: "POST",
      url: "https://gmail.googleapis.com/x?y=1",
    });
    expect(meta(call!).headers).toEqual(
      expect.arrayContaining([
        ["authorization", "Bearer t"],
        ["content-type", "text/plain"],
      ]),
    );
    expect(response.status).toBe(200);
    // Headers CORS would hide are readable (resumable uploads need it).
    expect(response.headers.get("location")).toBe(
      "https://upload.example/session",
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers without a body where the status has none", () => {
    const response = toResponse(
      framed({ status: 204, statusText: "No Content", headers: [] }),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("turns a request that got no answer into fetch's TypeError", async () => {
    const { fetch } = setup(() => Promise.reject(new Error("dns error")));
    await expect(fetch("https://nowhere.example/")).rejects.toThrow(TypeError);
  });

  it("aborts the native request", async () => {
    const controller = new AbortController();
    let reject: (reason: unknown) => void = () => undefined;
    const { fetch, calls } = setup((call) =>
      call.command === "net_fetch"
        ? new Promise((_, rejectWith) => {
            reject = rejectWith;
          })
        : Promise.resolve(undefined),
    );
    const pending = fetch("https://slow.example/", {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    reject("aborted");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const abort = calls.find((call) => call.command === "net_abort");
    expect(abort?.args).toEqual({ id: meta(calls[0]!).id });
  });
});
