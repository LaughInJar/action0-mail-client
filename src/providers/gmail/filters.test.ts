// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import type { ScopedSession } from "../../auth/types";
import {
  asFilterId,
  NO_ACTIONS,
  NO_CONDITIONS,
  type FilterSpec,
} from "../../core/filters";
import { asMailboxId } from "../../core/ids";
import { endOfDay, startOfDay } from "../localDays";
import {
  GmailFilterProvider,
  gmailSearchOf,
  SETTINGS_SCOPE,
  splitAlternatives,
  type GmailFilter,
  type GmailVacation,
} from "./filters";
import { GMAIL_API_BASE, GmailHttp } from "./http";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const url = (path: string) => `${GMAIL_API_BASE}${path}`;

function session(scopes: readonly string[] = [SETTINGS_SCOPE]): ScopedSession {
  return {
    hasScopes: (wanted) => wanted.every((scope) => scopes.includes(scope)),
    requestScopes: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
}

const provider = (scopes?: readonly string[]) =>
  new GmailFilterProvider(
    new GmailHttp({
      auth: new StaticAuthSession(),
      sleep: () => Promise.resolve(),
    }),
    session(scopes),
  );

const NEWSLETTER: GmailFilter = {
  id: "f1",
  criteria: { from: "news@shop.at OR deals@shop.at", hasAttachment: true },
  action: {
    addLabelIds: ["Label_7", "STARRED", "CATEGORY_PROMOTIONS"],
    removeLabelIds: ["INBOX", "UNREAD"],
  },
};

/** A fake Gmail settings API with filters, vacation and forwarding addresses. */
function gmailSettings(
  options: {
    filters?: GmailFilter[];
    vacation?: GmailVacation;
    forwarding?: { forwardingEmail: string; verificationStatus: string }[];
  } = {},
) {
  const state = {
    filters: [...(options.filters ?? [])],
    vacation: options.vacation ?? { enableAutoReply: false },
    created: [] as unknown[],
    deleted: [] as string[],
    put: undefined as unknown,
  };
  let next = 100;
  server.use(
    http.get(url("settings/filters"), () =>
      HttpResponse.json(state.filters.length ? { filter: state.filters } : {}),
    ),
    http.get(url("settings/filters/:id"), ({ params }) => {
      const found = state.filters.find((f) => f.id === params.id);
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json(
            { error: { message: "Not found" } },
            { status: 404 },
          );
    }),
    http.post(url("settings/filters"), async ({ request }) => {
      const body = (await request.json()) as Omit<GmailFilter, "id">;
      state.created.push(body);
      if (
        state.filters.some(
          (f) => JSON.stringify(f.criteria) === JSON.stringify(body.criteria),
        )
      )
        return HttpResponse.json(
          { error: { code: 400, message: "Filter already exists" } },
          { status: 400 },
        );
      const created = { ...body, id: `f${String(next++)}` };
      state.filters.push(created);
      return HttpResponse.json(created);
    }),
    http.delete(url("settings/filters/:id"), ({ params }) => {
      state.deleted.push(String(params.id));
      state.filters = state.filters.filter((f) => f.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(url("settings/vacation"), () => HttpResponse.json(state.vacation)),
    http.put(url("settings/vacation"), async ({ request }) => {
      state.put = await request.json();
      state.vacation = state.put as GmailVacation;
      return HttpResponse.json(state.vacation);
    }),
    http.get(url("settings/forwardingAddresses"), () =>
      HttpResponse.json({
        forwardingAddresses: options.forwarding ?? [
          {
            forwardingEmail: "me@backup.example",
            verificationStatus: "accepted",
          },
          {
            forwardingEmail: "new@else.example",
            verificationStatus: "pending",
          },
        ],
      }),
    ),
  );
  return state;
}

const spec = (changes: Partial<FilterSpec> = {}): FilterSpec => ({
  enabled: true,
  conditions: { ...NO_CONDITIONS, from: ["news@shop.at"] },
  actions: { ...NO_ACTIONS, skipInbox: true },
  ...changes,
});

describe("splitAlternatives", () => {
  it("reads Gmail's ways of writing any of several values", () => {
    expect(splitAlternatives("a@x.at OR b@y.at")).toEqual(["a@x.at", "b@y.at"]);
    expect(splitAlternatives("(a OR b)")).toEqual(["a", "b"]);
    expect(splitAlternatives("{a b}")).toEqual(["a", "b"]);
    expect(splitAlternatives('{"red wine" beer}')).toEqual([
      '"red wine"',
      "beer",
    ]);
    expect(splitAlternatives("Anna Berger")).toEqual(["Anna Berger"]);
    expect(splitAlternatives('"x OR y" OR z')).toEqual(['"x OR y"', "z"]);
    expect(splitAlternatives("(a OR b) c")).toEqual(["(a OR b) c"]);
    expect(splitAlternatives("  ")).toEqual([]);
  });
});

describe("GmailFilterProvider.load", () => {
  it("maps filters, the vacation responder and verified forwarding addresses", async () => {
    gmailSettings({
      filters: [
        NEWSLETTER,
        {
          id: "f2",
          criteria: {
            subject: "invoice",
            query: "{paid due}",
            negatedQuery: "spam",
            size: 1_000_000,
            sizeComparison: "larger",
          },
          action: {
            addLabelIds: ["TRASH"],
            removeLabelIds: ["SPAM"],
            forward: "me@backup.example",
          },
        },
      ],
      vacation: {
        enableAutoReply: true,
        responseSubject: "Away",
        responseBodyPlainText: "Back on <Monday>\n\nAnna",
        restrictToContacts: true,
        startTime: String(startOfDay("2026-11-02")),
        endTime: String(endOfDay("2026-11-06") - 1),
      },
    });
    const setup = await provider().load();
    expect(setup.readOnly).toBeUndefined();
    expect(setup.forwardAddresses).toEqual(["me@backup.example"]);
    expect(setup.capabilities.order).toBe(false);
    const [first, second] = setup.filters;
    expect(first).toEqual({
      id: asFilterId("f1"),
      enabled: true,
      more: true,
      conditions: {
        ...NO_CONDITIONS,
        from: ["news@shop.at", "deals@shop.at"],
        hasAttachment: true,
      },
      actions: {
        ...NO_ACTIONS,
        skipInbox: true,
        markRead: true,
        star: true,
        labels: [asMailboxId("Label_7")],
      },
    });
    expect(second).toMatchObject({
      more: false,
      conditions: {
        subject: ["invoice"],
        words: ["paid", "due"],
        notWords: ["spam"],
        size: { compare: "larger", bytes: 1_000_000 },
      },
      actions: {
        trash: true,
        neverSpam: true,
        forwardTo: ["me@backup.example"],
      },
    });
    expect(setup.autoReply).toEqual({
      enabled: true,
      start: "2026-11-02",
      end: "2026-11-06",
      subject: "Away",
      text: "<div>Back on &lt;Monday&gt;</div><div><br></div><div>Anna</div>",
      contactsOnly: true,
    });
  });

  it("is read-only without the settings permission", async () => {
    gmailSettings();
    const setup = await provider([]).load();
    expect(setup.readOnly).toBe("permission");
    expect(setup.filters).toEqual([]);
  });
});

describe("GmailFilterProvider changes", () => {
  it("creates a filter without retrying, in Gmail's words", async () => {
    const state = gmailSettings();
    const created = await provider().create(
      spec({
        conditions: {
          ...NO_CONDITIONS,
          from: ["a@x.at", "b@y.at"],
          notWords: ["ads", "promo"],
          size: { compare: "smaller", bytes: 5000 },
        },
        actions: {
          ...NO_ACTIONS,
          skipInbox: true,
          labels: [asMailboxId("Label_3")],
          markRead: true,
        },
      }),
    );
    expect(state.created).toEqual([
      {
        criteria: {
          from: "a@x.at OR b@y.at",
          negatedQuery: "ads OR promo",
          size: 5000,
          sizeComparison: "smaller",
        },
        action: {
          addLabelIds: ["Label_3"],
          removeLabelIds: ["INBOX", "UNREAD"],
        },
      },
    ]);
    expect(created.id).toBe(asFilterId("f100"));
    expect(created.conditions.from).toEqual(["a@x.at", "b@y.at"]);
  });

  it("edits by creating the new version first and keeps what action0 doesn't show", async () => {
    const state = gmailSettings({
      filters: [
        {
          ...NEWSLETTER,
          criteria: { ...NEWSLETTER.criteria, excludeChats: true },
        },
      ],
    });
    const changed = await provider().update(
      asFilterId("f1"),
      spec({
        conditions: { ...NO_CONDITIONS, from: ["news@shop.at"] },
        actions: { ...NO_ACTIONS, trash: true },
      }),
    );
    expect(state.created).toEqual([
      {
        criteria: { excludeChats: true, from: "news@shop.at" },
        action: {
          addLabelIds: ["CATEGORY_PROMOTIONS", "TRASH"],
        },
      },
    ]);
    expect(state.deleted).toEqual(["f1"]);
    expect(changed).toMatchObject({ id: "f100", more: true });
    expect(state.filters.map((f) => f.id)).toEqual(["f100"]);
  });

  it("keeps the old filter when the new version is refused", async () => {
    const state = gmailSettings({
      filters: [
        NEWSLETTER,
        { id: "f2", criteria: { from: "other@x.at" }, action: {} },
      ],
    });
    await expect(
      provider().update(
        asFilterId("f1"),
        spec({ conditions: { ...NO_CONDITIONS, from: ["other@x.at"] } }),
      ),
    ).rejects.toMatchObject({ reason: "filterExists" });
    expect(state.deleted).toEqual([]);
    expect(state.filters.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("forwards only to verified addresses", async () => {
    const state = gmailSettings();
    await expect(
      provider().create(
        spec({ actions: { ...NO_ACTIONS, forwardTo: ["new@else.example"] } }),
      ),
    ).rejects.toMatchObject({
      reason: "forwardNotAllowed",
      params: { address: "new@else.example" },
    });
    expect(state.created).toEqual([]);
    await provider().create(
      spec({ actions: { ...NO_ACTIONS, forwardTo: ["ME@backup.example"] } }),
    );
    expect(state.created).toEqual([
      {
        criteria: { from: "news@shop.at" },
        action: { forward: "ME@backup.example" },
      },
    ]);
  });

  it("says when changing settings isn't allowed", async () => {
    gmailSettings({ filters: [NEWSLETTER] });
    server.use(
      http.delete(url("settings/filters/:id"), () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(provider().remove(asFilterId("f1"))).rejects.toMatchObject({
      code: "unavailable",
      reason: "settingsNotAllowed",
    });
  });

  it("has no order or on/off switch", async () => {
    await expect(provider().setEnabled()).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(provider().reorder()).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("GmailFilterProvider automatic replies", () => {
  it("replaces the vacation settings and keeps what action0 doesn't show", async () => {
    const state = gmailSettings({
      vacation: {
        enableAutoReply: false,
        responseBodyPlainText: "old",
        restrictToDomain: true,
        startTime: "1",
        endTime: "2",
      },
    });
    await provider().setAutoReply({
      enabled: true,
      start: "2026-12-22",
      end: "2027-01-06",
      subject: "Holidays",
      text: "<p>Back in January</p>",
      contactsOnly: false,
    });
    expect(state.put).toEqual({
      enableAutoReply: true,
      responseSubject: "Holidays",
      responseBodyHtml: "<p>Back in January</p>",
      restrictToContacts: false,
      restrictToDomain: true,
      startTime: String(startOfDay("2026-12-22")),
      endTime: String(endOfDay("2027-01-06") - 1),
    });
    expect(await provider().autoReply()).toEqual({
      enabled: true,
      start: "2026-12-22",
      end: "2027-01-06",
      subject: "Holidays",
      text: "<p>Back in January</p>",
      contactsOnly: false,
    });
    await provider().setAutoReply({
      enabled: false,
      subject: "Holidays",
      text: "<p>Back in January</p>",
      contactsOnly: false,
    });
    expect(state.put).not.toHaveProperty("startTime");
    expect(state.put).not.toHaveProperty("endTime");
  });
});

describe("gmailSearchOf", () => {
  it("searches the way Gmail matches the criteria", () => {
    expect(
      gmailSearchOf({
        ...NO_CONDITIONS,
        from: ["a@x.at", "b@y.at"],
        to: ["me@x.at"],
        subject: ["Your order"],
        words: ["paid"],
        notWords: ["spam", "ads"],
        hasAttachment: true,
        size: { compare: "larger", bytes: 1000 },
      }),
    ).toBe(
      "from:(a@x.at OR b@y.at) to:me@x.at subject:(Your order) paid -(spam OR ads) has:attachment larger:1000",
    );
  });
});
