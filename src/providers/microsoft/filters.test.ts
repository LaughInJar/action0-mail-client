// @vitest-environment node
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import {
  asFilterId,
  NO_ACTIONS,
  NO_CONDITIONS,
  type FilterSpec,
} from "../../core/filters";
import { asMailboxId } from "../../core/ids";
import { FakeGraph } from "../../test/graphServer";
import { endOfDay, startOfDay } from "../localDays";
import {
  GraphFilterProvider,
  graphSearchOf,
  type GraphMessageRule,
} from "./filters";
import { categoryId } from "./folders";
import { GraphHttp } from "./http";

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

function setup(options: { personal?: boolean } = {}) {
  const graph = new FakeGraph();
  server.use(...graph.handlers());
  const provider = new GraphFilterProvider(
    new GraphHttp({
      auth: new StaticAuthSession(),
      sleep: () => Promise.resolve(),
    }),
    options,
  );
  return { graph, provider };
}

const rule = (
  id: string,
  sequence: number,
  changes: Partial<GraphMessageRule> = {},
): GraphMessageRule => ({
  id,
  displayName: id,
  sequence,
  isEnabled: true,
  hasError: false,
  isReadOnly: false,
  conditions: { subjectContains: [id] },
  actions: { markAsRead: true },
  ...changes,
});

const spec = (changes: Partial<FilterSpec> = {}): FilterSpec => ({
  enabled: true,
  conditions: { ...NO_CONDITIONS, from: ["news@shop.at"] },
  actions: { ...NO_ACTIONS, markRead: true },
  ...changes,
});

const sequences = (graph: FakeGraph) =>
  [...graph.rules]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((r) => `${r.id}:${String(r.sequence)}`);

describe("GraphFilterProvider.load", () => {
  it("maps rules in their order, with what action0 doesn't show marked", async () => {
    const { graph, provider } = setup();
    graph.rules = [
      rule("second", 2, {
        isEnabled: false,
        hasError: true,
        conditions: {
          fromAddresses: [{ emailAddress: { address: "boss@contoso.com" } }],
          senderContains: ["contoso"],
          sentToAddresses: [{ emailAddress: { address: "team@contoso.com" } }],
          recipientContains: ["sales"],
          hasAttachments: true,
          withinSizeRange: { minimumSize: 100, maximumSize: 1_048_576 },
        },
        exceptions: { bodyOrSubjectContains: ["newsletter"] },
        actions: {
          moveToFolder: "projects-id",
          assignCategories: ["Red", "Travel"],
          forwardTo: [{ emailAddress: { address: "me@home.example" } }],
          stopProcessingRules: true,
          delete: true,
          markAsRead: false,
        },
      }),
      rule("first", 1, {
        conditions: {
          subjectContains: ["invoice"],
          bodyOrSubjectContains: ["paid"],
          importance: "high",
          isAutomaticReply: false,
        },
        actions: { markImportance: "high", stopProcessingRules: false },
      }),
      rule("ranged", 3, {
        isReadOnly: true,
        conditions: { withinSizeRange: { minimumSize: 10, maximumSize: 20 } },
      }),
    ];
    const setup2 = await provider.load();
    expect(setup2.capabilities).toMatchObject({
      order: true,
      toggle: true,
      names: true,
      forward: "any",
      scope: "inbox",
      autoReply: { contactsOnly: false, outside: true, subject: false },
    });
    const [first, second, ranged] = setup2.filters;
    expect(first).toEqual({
      id: asFilterId("first"),
      name: "first",
      enabled: true,
      more: true,
      conditions: {
        ...NO_CONDITIONS,
        subject: ["invoice"],
        words: ["paid"],
      },
      actions: NO_ACTIONS,
    });
    expect(second).toEqual({
      id: asFilterId("second"),
      name: "second",
      enabled: false,
      more: false,
      problem: "error",
      conditions: {
        ...NO_CONDITIONS,
        from: ["boss@contoso.com", "contoso"],
        to: ["team@contoso.com", "sales"],
        notWords: ["newsletter"],
        hasAttachment: true,
        size: { compare: "larger", bytes: 102_400 },
      },
      actions: {
        ...NO_ACTIONS,
        moveTo: asMailboxId("projects-id"),
        labels: [categoryId("Red"), categoryId("Travel")],
        forwardTo: ["me@home.example"],
        trash: true,
        stop: true,
      },
    });
    expect(ranged).toMatchObject({ more: true, problem: "readOnly" });
    expect(ranged?.conditions.size).toBeUndefined();
  });
});

describe("GraphFilterProvider changes", () => {
  it("creates a rule with a name, last or at a place", async () => {
    const { graph, provider } = setup();
    graph.rules = [rule("a", 1), rule("b", 2)];
    const created = await provider.create(
      spec({
        conditions: {
          ...NO_CONDITIONS,
          from: ["news@shop.at", "Shop"],
          notWords: ["receipt"],
          size: { compare: "smaller", bytes: 2048 },
        },
        actions: {
          ...NO_ACTIONS,
          labels: [categoryId("Shopping"), asMailboxId("not-a-category")],
          stop: true,
        },
      }),
    );
    const [post] = graph.requests(
      "POST",
      /^me\/mailFolders\/inbox\/messageRules$/,
    );
    expect(post?.body).toEqual({
      displayName: "news@shop.at",
      sequence: 3,
      isEnabled: true,
      conditions: {
        fromAddresses: [{ emailAddress: { address: "news@shop.at" } }],
        senderContains: ["Shop"],
        withinSizeRange: { minimumSize: 0, maximumSize: 2 },
      },
      exceptions: { bodyOrSubjectContains: ["receipt"] },
      actions: { assignCategories: ["Shopping"], stopProcessingRules: true },
    });
    expect(created).toMatchObject({ name: "news@shop.at", more: false });
    expect(sequences(graph)).toEqual(["a:1", "b:2", `${created.id}:3`]);

    const placed = await provider.create(
      spec({ name: "Up front", actions: { ...NO_ACTIONS, trash: true } }),
      0,
    );
    expect(placed.name).toBe("Up front");
    expect(sequences(graph)).toEqual([
      `${placed.id}:1`,
      "a:2",
      "b:3",
      `${created.id}:4`,
    ]);
  });

  it("changes only what action0 shows", async () => {
    const { graph, provider } = setup();
    graph.rules = [
      rule("r", 1, {
        displayName: "Partner mail",
        conditions: {
          senderContains: ["partner"],
          importance: "high",
          withinSizeRange: { minimumSize: 10, maximumSize: 20 },
        },
        exceptions: { bodyOrSubjectContains: ["ads"], isAutomaticReply: true },
        actions: {
          markAsRead: true,
          markImportance: "high",
          forwardTo: [{ emailAddress: { address: "x@y.example" } }],
        },
      }),
    ];
    const changed = await provider.update(
      asFilterId("r"),
      spec({
        enabled: false,
        conditions: { ...NO_CONDITIONS, subject: ["contract"] },
        actions: { ...NO_ACTIONS, moveTo: asMailboxId("clients-id") },
      }),
    );
    expect(graph.rules[0]).toMatchObject({
      displayName: "Partner mail",
      isEnabled: false,
      conditions: {
        importance: "high",
        withinSizeRange: { minimumSize: 10, maximumSize: 20 },
        subjectContains: ["contract"],
      },
      exceptions: { isAutomaticReply: true },
      actions: { markImportance: "high", moveToFolder: "clients-id" },
    });
    expect(graph.rules[0]?.conditions).not.toHaveProperty("senderContains");
    expect(graph.rules[0]?.exceptions).not.toHaveProperty(
      "bodyOrSubjectContains",
    );
    expect(graph.rules[0]?.actions).not.toHaveProperty("forwardTo");
    expect(graph.rules[0]?.actions).not.toHaveProperty("markAsRead");
    expect(changed).toMatchObject({ enabled: false, more: true });
  });

  it("switches, reorders and deletes rules", async () => {
    const { graph, provider } = setup();
    graph.rules = [rule("a", 1), rule("b", 2), rule("c", 3)];
    await provider.setEnabled(asFilterId("b"), false);
    expect(graph.rules.find((r) => r.id === "b")?.isEnabled).toBe(false);
    await provider.reorder([asFilterId("c"), asFilterId("a"), asFilterId("b")]);
    expect(sequences(graph)).toEqual(["c:1", "a:2", "b:3"]);
    // Only the rules whose place changed were written.
    expect(
      graph.requests("PATCH", /messageRules\/[abc]$/).map((r) => r.body),
    ).toEqual([
      { isEnabled: false },
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]);
    await provider.remove(asFilterId("a"));
    expect(graph.rules.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("GraphFilterProvider automatic replies", () => {
  it("work accounts: messages inside and outside the organisation", async () => {
    const { graph, provider } = setup();
    graph.automaticReplies = {
      status: "scheduled",
      externalAudience: "contactsOnly",
      internalReplyMessage: "<p>Inside</p>",
      externalReplyMessage: "<p>Outside</p>",
      scheduledStartDateTime: {
        dateTime: new Date(startOfDay("2026-11-02")).toISOString().slice(0, 19),
        timeZone: "UTC",
      },
      scheduledEndDateTime: {
        dateTime: `${new Date(endOfDay("2026-11-06")).toISOString().slice(0, 19)}.0000000`,
        timeZone: "UTC",
      },
    };
    expect(await provider.autoReply()).toEqual({
      enabled: true,
      start: "2026-11-02",
      end: "2026-11-06",
      subject: "",
      text: "<p>Inside</p>",
      contactsOnly: false,
      outside: { audience: "contacts", text: "<p>Outside</p>" },
    });

    await provider.setAutoReply({
      enabled: true,
      subject: "",
      text: "<p>Away</p>",
      contactsOnly: false,
      outside: { audience: "none", text: "" },
    });
    expect(graph.automaticReplies).toMatchObject({
      status: "alwaysEnabled",
      internalReplyMessage: "<p>Away</p>",
      externalReplyMessage: "",
      externalAudience: "none",
    });
    expect((await provider.autoReply()).start).toBeUndefined();
  });

  it("personal accounts: one message, contacts only, open end", async () => {
    const { graph, provider } = setup({ personal: true });
    await provider.setAutoReply({
      enabled: true,
      start: "2026-12-22",
      subject: "",
      text: "<p>Holidays</p>",
      contactsOnly: true,
    });
    expect(graph.automaticReplies).toMatchObject({
      status: "scheduled",
      internalReplyMessage: "<p>Holidays</p>",
      externalReplyMessage: "<p>Holidays</p>",
      externalAudience: "contactsOnly",
      scheduledStartDateTime: {
        dateTime: new Date(startOfDay("2026-12-22")).toISOString().slice(0, 19),
        timeZone: "UTC",
      },
    });
    expect(await provider.autoReply()).toEqual({
      enabled: true,
      start: "2026-12-22",
      subject: "",
      text: "<p>Holidays</p>",
      contactsOnly: true,
    });
    const setup2 = await provider.load();
    expect(setup2.capabilities.autoReply).toMatchObject({
      contactsOnly: true,
      outside: false,
    });

    await provider.setAutoReply({
      enabled: false,
      subject: "",
      text: "<p>Holidays</p>",
      contactsOnly: true,
    });
    expect(graph.automaticReplies.status).toBe("disabled");
    expect((await provider.autoReply()).enabled).toBe(false);
  });
});

describe("graphSearchOf", () => {
  it("writes KQL for the rule's conditions", () => {
    expect(
      graphSearchOf({
        ...NO_CONDITIONS,
        from: ["a@x.at", "b@y.at"],
        to: ["sales"],
        subject: ["Your order"],
        words: ["paid"],
        notWords: ["spam"],
        hasAttachment: true,
        size: { compare: "larger", bytes: 1000 },
      }),
    ).toBe(
      '(from:a@x.at OR from:b@y.at) AND recipients:sales AND subject:"Your order" AND (subject:paid OR body:paid) AND hasAttachments:true AND size>1000 AND NOT (subject:spam OR body:spam)',
    );
    expect(graphSearchOf({ ...NO_CONDITIONS, notWords: ["x"] })).toBe(
      "NOT (subject:x OR body:x)",
    );
  });
});
