// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNewer, openTarget } from "./android";

describe("openTarget", () => {
  it("reads a notification's link", () => {
    expect(
      openTarget("action0://open?account=gmail%3Ame%40example.com&message=m1"),
    ).toEqual({ accountId: "gmail:me@example.com", messageId: "m1" });
    expect(openTarget("action0://open?account=microsoft%3Amax")).toEqual({
      accountId: "microsoft:max",
    });
  });

  it("refuses anything else", () => {
    expect(openTarget("https://example.org/?account=x")).toBeNull();
    expect(openTarget("action0://open")).toBeNull();
    expect(openTarget("not a link")).toBeNull();
  });
});

describe("isNewer", () => {
  it("compares versions part by part", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("v1.10.0", "1.9.3")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
});
