import { describe, expect, it, vi } from "vitest";
import { asAccountId, asMailboxId, asMessageId } from "../core/ids";
import { createHashRouter, formatRoute, parseHash, sameList } from "./router";

const route = {
  accountId: asAccountId("gmail:jane@example.com"),
  mailboxId: asMailboxId("Label_1/x"),
  messageId: asMessageId("18c#1"),
};

describe("parseHash / formatRoute", () => {
  it("round-trips opaque ids with special characters", () => {
    const hash = formatRoute(route);
    expect(hash).toBe("#/gmail%3Ajane%40example.com/Label_1%2Fx/18c%231");
    expect(parseHash(hash)).toEqual(route);
  });

  it("treats empty, partial or malformed hashes as the root", () => {
    for (const hash of ["", "#", "#/", "#/only-account", "#/a/b/c/d"]) {
      expect(parseHash(hash)).toBeNull();
    }
    expect(formatRoute(null)).toBe("#/");
  });

  it("compares lists without the message", () => {
    expect(
      sameList(route, {
        accountId: route.accountId,
        mailboxId: route.mailboxId,
      }),
    ).toBe(true);
    expect(sameList(route, null)).toBe(false);
  });
});

describe("createHashRouter", () => {
  it("pushes or replaces history entries and notifies subscribers", () => {
    const router = createHashRouter(window);
    const listener = vi.fn();
    router.subscribe(listener);
    const list = { accountId: route.accountId, mailboxId: route.mailboxId };

    router.navigate(list);
    expect(window.location.hash).toBe(formatRoute(list));
    expect(router.canGoBack()).toBe(true);
    const depth = window.history.length;

    router.navigate(route, { replace: true });
    expect(window.history.length).toBe(depth);
    expect(router.getRoute()).toEqual(route);
    expect(listener).toHaveBeenCalledTimes(2);

    // Navigating to the current route is a no-op.
    router.navigate(route);
    expect(listener).toHaveBeenCalledTimes(2);
    router.dispose();
  });

  it("follows external hash changes", () => {
    const router = createHashRouter(window);
    window.location.hash = formatRoute(route);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(router.getRoute()).toEqual(route);
    router.dispose();
  });
});
