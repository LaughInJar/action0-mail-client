// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha1Hex } from "./fingerprint";

describe("sha1Hex", () => {
  it("shows a base64 SHA-1 the way Google Cloud does", () => {
    expect(sha1Hex("ga0RGNYHvNM5d0SLGQfpQWAPGJ8=")).toBe(
      "81:AD:11:18:D6:07:BC:D3:39:77:44:8B:19:07:E9:41:60:0F:18:9F",
    );
    expect(sha1Hex("not base64!")).toBe("not base64!");
  });
});
