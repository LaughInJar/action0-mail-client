import { describe, expect, it, vi } from "vitest";
import { NativeAuthError } from "../../auth/native/bridge";
import { createAuthBridge, toNativeError } from "./authBridge";
import type { Invoke } from "./nativeFetch";

describe("the native sign-in bridge", () => {
  it("passes requests on with the page the browser shows afterwards", async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({ key: "gmail:a@b.c", email: "a@b.c", scopes: [] }),
    );
    const bridge = createAuthBridge(invoke as unknown as Invoke, () => ({
      done: "Done",
      failed: "Failed",
    }));
    const request = {
      provider: "google" as const,
      client: { id: "id", secret: "s" },
      scopes: ["openid"],
      required: [],
      prompt: "select_account" as const,
    };
    await bridge.connect(request);
    expect(invoke).toHaveBeenCalledWith("auth_connect", {
      request: { ...request, page: { done: "Done", failed: "Failed" } },
    });
    await bridge.token("gmail:a@b.c", ["x"]);
    expect(invoke).toHaveBeenLastCalledWith("auth_token", {
      key: "gmail:a@b.c",
      scopes: ["x"],
    });
  });

  it("turns native refusals into NativeAuthErrors", async () => {
    // Tauri rejects with the command's error value, not an Error.
    const refusal = {
      kind: "reauth",
      message: "Token has been expired or revoked.",
    };
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- what Tauri does
    const invoke: Invoke = () => Promise.reject(refusal);
    const bridge = createAuthBridge(invoke, () => ({
      done: "",
      failed: "",
    }));
    const error = await bridge.token("k", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeAuthError);
    expect(error).toMatchObject({ kind: "reauth" });
    expect(toNativeError("plain")).toBe("plain");
    expect(toNativeError({ kind: "other" })).toEqual({ kind: "other" });
  });
});
