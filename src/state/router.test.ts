import { describe, expect, it, vi } from "vitest";
import { asAccountId, asMailboxId, asMessageId } from "../core/ids";
import {
  createHashRouter,
  formatLocation,
  formatRoute,
  hasSettingsFlag,
  listRoute,
  parseHash,
  sameList,
} from "./router";

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

  it("keeps a search in the query part, text exactly as typed", () => {
    const searched = {
      ...route,
      search: { text: "from:bob & #1/ä?", everywhere: false },
    };
    const hash = formatRoute(searched);
    expect(hash).toBe(
      "#/gmail%3Ajane%40example.com/Label_1%2Fx/18c%231?q=from%3Abob+%26+%231%2F%C3%A4%3F",
    );
    expect(parseHash(hash)).toEqual(searched);

    const everywhere = {
      ...searched,
      search: { text: "invoice", everywhere: true },
    };
    expect(formatRoute(everywhere)).toMatch(/\?q=invoice&in=all$/);
    expect(parseHash(formatRoute(everywhere))).toEqual(everywhere);
  });

  it("keeps an open composer in the URL, next to a search", () => {
    const composing = {
      accountId: route.accountId,
      mailboxId: route.mailboxId,
      search: { text: "invoice", everywhere: false },
      compose: "r-123",
    };
    expect(formatRoute(composing)).toMatch(/\?q=invoice&compose=r-123$/);
    expect(parseHash(formatRoute(composing))).toEqual(composing);
    expect(
      formatRoute({
        accountId: route.accountId,
        mailboxId: route.mailboxId,
        compose: "new",
      }),
    ).toMatch(/\/Label_1%2Fx\?compose=new$/);
  });

  it("ignores blank searches and unknown parameters", () => {
    const list = { accountId: route.accountId, mailboxId: route.mailboxId };
    expect(
      formatRoute({ ...list, search: { text: "  ", everywhere: true } }),
    ).toBe(formatRoute(list));
    expect(parseHash(`${formatRoute(list)}?q=+&in=all&x=1`)).toEqual(list);
  });

  it("compares lists without the message", () => {
    expect(
      sameList(route, {
        accountId: route.accountId,
        mailboxId: route.mailboxId,
      }),
    ).toBe(true);
    expect(sameList(route, null)).toBe(false);
    expect(listRoute(route)).toEqual({
      accountId: route.accountId,
      mailboxId: route.mailboxId,
    });
  });

  it("treats a search, or searching everywhere, as another list", () => {
    const search = { text: "invoice", everywhere: false };
    expect(sameList(route, { ...route, search })).toBe(false);
    expect(
      sameList(
        { ...route, search },
        {
          accountId: route.accountId,
          mailboxId: route.mailboxId,
          search: { ...search },
        },
      ),
    ).toBe(true);
    expect(
      sameList(
        { ...route, search },
        { ...route, search: { ...search, everywhere: true } },
      ),
    ).toBe(false);
    expect(listRoute({ ...route, search })).toEqual({
      accountId: route.accountId,
      mailboxId: route.mailboxId,
      search,
    });
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

  it("opens Settings over the route; Back and closing remove it", () => {
    const router = createHashRouter(window);
    const list = { accountId: route.accountId, mailboxId: route.mailboxId };
    router.navigate(list);
    const length = window.history.length;

    router.openSettings();
    expect(router.isSettingsOpen()).toBe(true);
    expect(window.location.hash).toBe(`${formatRoute(list)}?settings`);
    expect(window.history.length).toBe(length + 1);
    expect(router.getRoute()).toEqual(list);

    // Replacing (e.g. the cursor moving) keeps it open; a new entry closes it.
    router.navigate(route, { replace: true });
    expect(router.isSettingsOpen()).toBe(true);
    expect(hasSettingsFlag(window.location.hash)).toBe(true);
    router.navigate(list);
    expect(router.isSettingsOpen()).toBe(false);

    // Opened from a reloaded URL (no entry of ours): closing removes the flag.
    window.history.replaceState(null, "", formatLocation(list, true));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(router.isSettingsOpen()).toBe(true);
    router.closeSettings();
    expect(router.isSettingsOpen()).toBe(false);
    expect(window.location.hash).toBe(formatRoute(list));
    router.dispose();
  });

  it("keeps the settings flag on the root route too", () => {
    expect(formatLocation(null, true)).toBe("#/?settings");
    expect(hasSettingsFlag("#/?settings")).toBe(true);
    expect(parseHash("#/?settings")).toBeNull();
    expect(formatLocation(route, false)).toBe(formatRoute(route));
  });

  it("follows external hash changes", () => {
    const router = createHashRouter(window);
    window.location.hash = formatRoute(route);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(router.getRoute()).toEqual(route);
    router.dispose();
  });
});
