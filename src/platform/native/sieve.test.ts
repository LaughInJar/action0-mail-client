import { describe, expect, it, vi } from "vitest";
import { MailServerError } from "../../accounts/mailServer";
import type { Invoke } from "./nativeFetch";
import { createNativeSieveBridge } from "./sieve";

interface Call {
  readonly command: string;
  readonly args: unknown;
}

function setup(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const invoke = vi.fn((command: string, args?: unknown) => {
    const call = { command, args };
    calls.push(call);
    return answer(call);
  }) as unknown as Invoke;
  return { bridge: createNativeSieveBridge(invoke), calls };
}

const KEY = "imap:max@example.org";

describe("the native filter server bridge", () => {
  it("names the commands and passes their arguments", async () => {
    const server = {
      host: "imap.example.org",
      port: 4190,
      extensions: ["fileinto", "vacation"],
      chosen: false,
    };
    const { bridge, calls } = setup(({ command }) =>
      Promise.resolve(
        command === "sieve_read"
          ? { name: "rules", script: "keep;\n", extensions: ["fileinto"] }
          : command === "sieve_write"
            ? null
            : command === "sieve_set_server"
              ? { ...server, chosen: true }
              : server,
      ),
    );
    expect(await bridge.find(KEY)).toEqual(server);
    expect(await bridge.known(KEY)).toEqual(server);
    expect(
      await bridge.setServer(KEY, { host: "sieve.example.org", port: 4190 }),
    ).toMatchObject({ chosen: true });
    await bridge.setServer(KEY, null);
    expect(await bridge.read(KEY)).toEqual({
      name: "rules",
      script: "keep;\n",
      extensions: ["fileinto"],
    });
    await bridge.write(KEY, {
      name: "rules",
      script: "stop;\n",
      expected: "keep;\n",
      activate: false,
    });
    expect(calls).toEqual([
      { command: "sieve_find", args: { key: KEY } },
      { command: "sieve_known", args: { key: KEY } },
      {
        command: "sieve_set_server",
        args: { key: KEY, server: { host: "sieve.example.org", port: 4190 } },
      },
      { command: "sieve_set_server", args: { key: KEY, server: null } },
      { command: "sieve_read", args: { key: KEY } },
      {
        command: "sieve_write",
        args: {
          key: KEY,
          request: {
            name: "rules",
            script: "stop;\n",
            expected: "keep;\n",
            activate: false,
          },
        },
      },
    ]);
  });

  it("rejects with the native side's error, naming the filter server", async () => {
    const { bridge } = setup(() =>
      Promise.reject(
        // Tauri rejects with the command's JSON error.
        Object.assign(
          new Error("The filters were changed somewhere else meanwhile."),
          { kind: "changed", server: "sieve" },
        ),
      ),
    );
    const error = await bridge
      .write(KEY, { name: "x", script: "", expected: "", activate: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailServerError);
    expect(error).toMatchObject({ kind: "changed", server: "sieve" });
    await expect(bridge.find(KEY)).rejects.toMatchObject({ kind: "changed" });
  });
});
