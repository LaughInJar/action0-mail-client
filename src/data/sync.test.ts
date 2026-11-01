import { describe, expect, it, vi } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { asMailboxId, asMessageId } from "../core/ids";
import type { Mailbox, MessageSummary } from "../core/model";
import {
  createDemoArrival,
  createDemoData,
  DEMO_MAILBOX,
} from "../providers/fake/demoData";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { createDemoModule, DEMO_ACCOUNT } from "../providers/fake/module";
import { queryKeys, type ListSpec } from "./keys";
import type { MessageListData } from "./optimistic";
import { createQueryClient } from "./queryClient";
import { createMailSync, inboxArrivals } from "./sync";

async function setup() {
  let now = Date.parse("2026-10-18T12:00:00Z");
  const registry = new AccountRegistry({
    modules: [
      createDemoModule({
        latencyMs: 0,
        data: () => createDemoData(Date.parse("2026-10-18T12:00:00Z")),
        arrivalEveryMs: 60_000,
        now: () => now,
      }),
    ],
    storage: undefined,
  });
  await registry.add("demo");
  const provider = registry.get(DEMO_ACCOUNT.id)?.provider as FakeMailProvider;
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    queryKeys.mailboxes(DEMO_ACCOUNT.id),
    await provider.listMailboxes(),
  );
  const inbox: ListSpec = { mailboxId: DEMO_MAILBOX.inbox, order: "newest" };
  const page = await provider.listMessages({ ...inbox, limit: 50 });
  queryClient.setQueryData<MessageListData>(
    queryKeys.messageList(DEMO_ACCOUNT.id, inbox),
    { pages: [page], pageParams: [undefined] },
  );
  const rows = () =>
    queryClient
      .getQueryData<MessageListData>(
        queryKeys.messageList(DEMO_ACCOUNT.id, inbox),
      )
      ?.pages.flatMap((p) => p.items.map((item) => item.id)) ?? [];
  const sync = createMailSync(queryClient, registry);
  return {
    sync,
    provider,
    queryClient,
    rows,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MailSync", () => {
  it("applies changes made elsewhere to the cached lists", async () => {
    const { sync, provider, rows } = await setup();
    expect(await sync.check(DEMO_ACCOUNT.id)).toBeUndefined();
    expect(rows()).toContain("welcome");
    // E.g. archived in Gmail on the phone.
    await provider.archive([asMessageId("welcome")]);
    expect(await sync.check(DEMO_ACCOUNT.id)).toBeUndefined();
    expect(rows()).not.toContain("welcome");
  });

  it("reports new unread Inbox mail as arrivals", async () => {
    const { sync, rows, advance } = await setup();
    await sync.check(DEMO_ACCOUNT.id);
    advance(61_000);
    const arrivals = await sync.check(DEMO_ACCOUNT.id);
    expect(arrivals?.inboxId).toBe(DEMO_MAILBOX.inbox);
    expect(arrivals?.messages).toHaveLength(1);
    expect(rows()[0]).toBe(arrivals?.messages[0]?.id);
    expect(createDemoArrival(0, 1).flags.seen).toBe(false);
  });

  it("doesn't count mail you send to yourself", async () => {
    const { sync, provider } = await setup();
    await sync.check(DEMO_ACCOUNT.id);
    const to = [{ address: "demo@example.com" }];
    const draft = {
      to,
      cc: [],
      bcc: [],
      subject: "Note",
      html: "<p>x</p>",
      text: "x",
      attachments: [],
    };
    const { id } = await provider.saveDraft(draft);
    await provider.sendDraft({ ...draft, id });
    expect(await sync.check(DEMO_ACCOUNT.id)).toBeUndefined();
  });

  it("waits while a change of the app's own is on its way", async () => {
    const { sync, provider, queryClient, rows } = await setup();
    await sync.check(DEMO_ACCOUNT.id);
    await provider.archive([asMessageId("welcome")]);
    const mutating = vi.spyOn(queryClient, "isMutating").mockReturnValue(1);
    await sync.check(DEMO_ACCOUNT.id);
    expect(rows()).toContain("welcome");
    mutating.mockRestore();
    // Nothing was lost: the next check still sees the change.
    await sync.check(DEMO_ACCOUNT.id);
    expect(rows()).not.toContain("welcome");
  });

  it("reloads everything when the provider says to start over", async () => {
    const { sync, provider, queryClient } = await setup();
    vi.spyOn(provider, "changesSince").mockResolvedValue({
      token: "t" as never,
      reset: true,
      changes: [],
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await sync.check(DEMO_ACCOUNT.id);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...queryKeys.account(DEMO_ACCOUNT.id)],
    });
  });
});

describe("inboxArrivals", () => {
  const inboxId = asMailboxId("inbox");
  const view = (standard: "focused" | "other", total: number): Mailbox => ({
    id: asMailboxId(standard),
    name: standard,
    kind: "view",
    standard,
    parentId: inboxId,
    selectable: true,
    hidden: true,
    assignable: false,
    counts: { total, unread: 0 },
  });
  const inbox: Mailbox = {
    id: inboxId,
    name: "Inbox",
    kind: "folder",
    role: "inbox",
    selectable: true,
    hidden: false,
    assignable: true,
  };
  const mail = (id: string, focus?: "focused" | "other"): MessageSummary => ({
    id: asMessageId(id),
    mailboxIds: [inboxId],
    to: [],
    subject: id,
    snippet: "",
    receivedAt: "2026-10-18T12:00:00.000Z",
    flags: { seen: false, flagged: false },
    hasAttachments: false,
    ...(focus ? { focus } : {}),
  });
  const arrivals = {
    accountId: DEMO_ACCOUNT.id,
    inboxId,
    messages: [mail("a", "focused"), mail("b", "other"), mail("c")],
  };

  it("counts only Focused's mail of a split Inbox, leading there", () => {
    const split = [inbox, view("focused", 2), view("other", 1)];
    expect(inboxArrivals(arrivals, split, undefined)).toEqual({
      ...arrivals,
      inboxId: asMailboxId("focused"),
      messages: [mail("a", "focused"), mail("c")],
    });
    expect(
      inboxArrivals(
        { ...arrivals, messages: [mail("b", "other")] },
        split,
        true,
      ),
    ).toBeUndefined();
    // Not split: everything, as before.
    expect(inboxArrivals(arrivals, split, false)).toBe(arrivals);
    expect(inboxArrivals(arrivals, [inbox], undefined)).toBe(arrivals);
  });
});
