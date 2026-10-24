import { describe, expect, it, vi } from "vitest";
import { asAccountId, asMailboxId, asMessageId } from "../core/ids";
import {
  createHashRouter,
  formatCalendarRoute,
  formatLocation,
  formatRoute,
  overlayOf,
  listRoute,
  parseCalendarHash,
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

  it("keeps All inboxes with its context account as one list", () => {
    const unified = { ...route, unified: true as const };
    const hash = formatRoute(unified);
    expect(hash.startsWith("#/all/")).toBe(true);
    expect(parseHash(hash)).toEqual(unified);
    const other = {
      accountId: asAccountId("gmail:b@example.com"),
      mailboxId: asMailboxId("INBOX"),
      unified: true as const,
    };
    expect(sameList(unified, other)).toBe(true);
    expect(sameList(unified, route)).toBe(false);
    expect(
      sameList(other, { ...other, search: { text: "x", everywhere: false } }),
    ).toBe(false);
    expect(parseHash("#/all")).toBeNull();
  });

  it("names the account of a full-screen draft", () => {
    const composing = {
      ...route,
      compose: "draft-1",
      composeAccount: asAccountId("gmail:b@example.com"),
    };
    expect(parseHash(formatRoute(composing))).toEqual(composing);
    // Without a composer the account means nothing.
    expect(parseHash(`${formatRoute(route)}?ca=x`)).toEqual(route);
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
    expect(overlayOf(window.location.hash)).toEqual({ kind: "settings" });
    router.navigate(list);
    expect(router.isSettingsOpen()).toBe(false);

    // Opened from a reloaded URL (no entry of ours): closing removes the flag.
    window.history.replaceState(
      null,
      "",
      formatLocation(list, { kind: "settings" }),
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(router.isSettingsOpen()).toBe(true);
    router.closeSettings();
    expect(router.isSettingsOpen()).toBe(false);
    expect(window.location.hash).toBe(formatRoute(list));
    router.dispose();
  });

  it("keeps the settings flag on the root route too", () => {
    expect(formatLocation(null, { kind: "settings" })).toBe("#/?settings");
    expect(overlayOf("#/?settings")).toEqual({ kind: "settings" });
    expect(parseHash("#/?settings")).toBeNull();
    expect(formatLocation(route, null)).toBe(formatRoute(route));
  });

  it("shows a message's original over the route; Back closes it", () => {
    const router = createHashRouter(window);
    const searched = {
      accountId: route.accountId,
      mailboxId: route.mailboxId,
      search: { text: "invoice", everywhere: false },
    };
    router.navigate(searched);
    const message = {
      accountId: asAccountId("other:b@example.com"),
      messageId: asMessageId("m/1"),
    };
    router.openOriginal(message);
    expect(window.location.hash).toBe(
      `${formatRoute(searched)}&original=m%2F1&oa=other%3Ab%40example.com`,
    );
    expect(router.getOriginal()).toEqual(message);
    // The same object while it stays open (for useSyncExternalStore).
    expect(router.getOriginal()).toBe(router.getOriginal());
    expect(router.getRoute()).toEqual(searched);
    expect(overlayOf(window.location.hash)).toEqual({
      kind: "original",
      message,
    });
    expect(router.isSettingsOpen()).toBe(false);

    // Without an entry of ours (a reloaded URL), closing removes it.
    window.history.replaceState(null, "", window.location.hash);
    router.closeOriginal();
    expect(router.getOriginal()).toBeNull();
    expect(window.location.hash).toBe(formatRoute(searched));
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

describe("calendar routes", () => {
  it("round-trip views, dates and an opaque event", () => {
    const calendar = {
      view: "week" as const,
      date: "2026-10-15",
      event: '["gmail:jane@example.com","cal/ev 1"]',
    };
    const hash = formatCalendarRoute(calendar);
    expect(hash.startsWith("#/calendar/week/2026-10-15/")).toBe(true);
    expect(parseCalendarHash(hash)).toEqual(calendar);
    // A calendar hash is no mail route.
    expect(parseHash(hash)).toBeNull();
    expect(parseCalendarHash(formatRoute(route))).toBeNull();
  });

  it("round-trip editing an event and creating one, with or without a time", () => {
    const editing = {
      view: "day" as const,
      date: "2026-10-15",
      event: '["acct","ev/1"]',
      edit: true as const,
    };
    expect(formatCalendarRoute(editing)).toMatch(/\/edit$/);
    expect(parseCalendarHash(formatCalendarRoute(editing))).toEqual(editing);
    const timed = {
      view: "week" as const,
      date: "2026-10-15",
      create: { from: "2026-10-15T10:00", to: "2026-10-15T11:00" },
    };
    expect(formatCalendarRoute(timed)).toBe(
      "#/calendar/week/2026-10-15/new/2026-10-15T10%3A00/2026-10-15T11%3A00",
    );
    expect(parseCalendarHash(formatCalendarRoute(timed))).toEqual(timed);
    const allDay = {
      view: "month" as const,
      date: "2026-10-15",
      create: { from: "2026-10-20", to: "2026-10-21" },
    };
    expect(parseCalendarHash(formatCalendarRoute(allDay))).toEqual(allDay);
    expect(parseCalendarHash("#/calendar/week/2026-10-15/new")).toEqual({
      view: "week",
      date: "2026-10-15",
      create: {},
    });
    // Times that aren't times are dropped; unknown segments aren't routes.
    expect(
      parseCalendarHash("#/calendar/week/2026-10-15/new/soon/later")?.create,
    ).toEqual({});
    expect(parseCalendarHash("#/calendar/week/2026-10-15/x/delete")).toBeNull();
  });

  it("repairs unknown views and dates", () => {
    expect(parseCalendarHash("#/calendar/year/2026-10-15")?.view).toBe("week");
    expect(parseCalendarHash("#/calendar/day/someday")?.date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("switches between mail and calendar and remembers the last mail route", () => {
    const router = createHashRouter(window);
    router.navigate(route);
    router.openCalendar({ view: "month", date: "2026-10-01" });
    expect(router.getRoute()).toBeNull();
    expect(router.getCalendarRoute()).toEqual({
      view: "month",
      date: "2026-10-01",
    });
    expect(router.getLastMailRoute()).toEqual(route);
    // Settings opens over the calendar too.
    router.openSettings();
    expect(overlayOf(window.location.hash)).toEqual({ kind: "settings" });
    expect(window.location.hash).toContain("#/calendar/month/2026-10-01");
    router.closeSettings();
    router.navigate(router.getLastMailRoute());
    expect(router.getCalendarRoute()).toBeNull();
    expect(router.getRoute()).toEqual(route);
    router.dispose();
  });
});
