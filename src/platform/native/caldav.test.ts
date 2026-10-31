import { describe, expect, it, vi } from "vitest";
import { MailServerError } from "../../accounts/mailServer";
import { createNativeCaldavBridge, toDavResponse } from "./caldav";
import type { Invoke } from "./nativeFetch";

/** The native side's answer: `[u32 meta length][meta][body]`. */
function framed(
  meta: { status: number; headers: [string, string][]; url: string },
  body = "",
): ArrayBuffer {
  const json = new TextEncoder().encode(
    JSON.stringify({ statusText: "", ...meta }),
  );
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
  return { bridge: createNativeCaldavBridge(invoke), calls };
}

describe("the native CalDAV bridge", () => {
  it("sends requests with their metadata and reads the framed answer", async () => {
    const { bridge, calls } = setup(() =>
      Promise.resolve(
        framed(
          {
            status: 207,
            headers: [
              ["Content-Type", "application/xml"],
              ["DAV", "1, 3"],
              ["DAV", "calendar-access"],
            ],
            url: "https://dav.example.org/cal/",
          },
          "<multistatus/>",
        ),
      ),
    );
    const answer = await bridge.request("caldav:a", {
      method: "PROPFIND",
      url: "https://dav.example.org/",
      headers: { Depth: "0" },
      body: "<propfind/>",
    });
    expect(answer).toEqual({
      status: 207,
      url: "https://dav.example.org/cal/",
      headers: {
        "content-type": "application/xml",
        dav: "1, 3, calendar-access",
      },
      body: "<multistatus/>",
    });
    const [call] = calls;
    expect(call?.command).toBe("caldav_request");
    expect(new TextDecoder().decode(call?.args as Uint8Array)).toBe(
      "<propfind/>",
    );
    expect(
      JSON.parse(decodeURIComponent(call?.headers?.["x-a0-caldav"] ?? "")),
    ).toMatchObject({
      key: "caldav:a",
      method: "PROPFIND",
      url: "https://dav.example.org/",
      headers: [["Depth", "0"]],
    });
  });

  it("turns the native side's errors into MailServerErrors", async () => {
    const { bridge } = setup(() =>
      Promise.reject(
        // Tauri rejects with the command's JSON error.
        Object.assign(
          new Error("The certificate of the calendar server isn't trusted."),
          {
            kind: "untrusted",
            server: "caldav",
            certificate: { sha256: "AB", server: "caldav" },
          },
        ),
      ),
    );
    const error: unknown = await bridge
      .connect({ urls: ["https://x/"], login: { sameAsMail: true } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailServerError);
    expect(error).toMatchObject({ kind: "untrusted", server: "caldav" });
  });

  it("aborts a request on the native side", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const { bridge, calls } = setup((call) =>
      call.command === "caldav_request"
        ? new Promise((_, no) => {
            reject = no;
          })
        : Promise.resolve(undefined),
    );
    const controller = new AbortController();
    const pending = bridge.request(
      "caldav:a",
      { method: "GET", url: "https://x/" },
      controller.signal,
    );
    controller.abort();
    reject({ kind: "server", message: "aborted" });
    await expect(pending).rejects.toThrow();
    expect(calls.map((call) => call.command)).toContain("caldav_abort");
  });

  it("looks for a server's address books", async () => {
    const info = {
      key: "imap:me@example.org",
      label: "me@example.org",
      home: "https://dav.example.org/cal/",
      principal: "https://dav.example.org/p/",
      username: "",
      sameAsMail: true,
      scheduling: false,
      pinned: false,
      contacts: "https://dav.example.org/card/",
      contactsChecked: true,
    };
    const { bridge, calls } = setup(() => Promise.resolve(info));
    expect(await bridge.findContacts("imap:me@example.org")).toEqual(info);
    expect(calls[0]).toMatchObject({
      command: "caldav_find_contacts",
      args: { key: "imap:me@example.org" },
    });
  });

  it("decodes an answer without a body", () => {
    expect(
      toDavResponse(framed({ status: 204, headers: [], url: "https://x/" })),
    ).toEqual({ status: 204, url: "https://x/", headers: {}, body: "" });
  });
});
