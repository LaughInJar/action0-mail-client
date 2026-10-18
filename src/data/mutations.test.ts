// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { asMessageId } from "../core/ids";
import { createDemoData, DEMO_MAILBOX } from "../providers/fake/demoData";
import { createDemoModule, DEMO_ACCOUNT } from "../providers/fake/module";
import { queryKeys } from "./keys";
import { previewIntent } from "./mutations";
import type { MessageListData } from "./optimistic";
import { createQueryClient } from "./queryClient";

async function setup() {
  const data = createDemoData(Date.parse("2026-10-18T12:00:00Z"));
  const registry = new AccountRegistry({
    modules: [createDemoModule({ latencyMs: 0, data: () => data })],
    storage: undefined,
  });
  await registry.add("demo");
  const queryClient = createQueryClient();
  const provider = registry.get(DEMO_ACCOUNT.id)?.provider;
  queryClient.setQueryData(
    queryKeys.mailboxes(DEMO_ACCOUNT.id),
    await provider?.listMailboxes(),
  );
  const page = await provider?.listMessages({
    mailboxId: DEMO_MAILBOX.inbox,
    limit: 5,
  });
  const list: MessageListData = {
    pages: page ? [page] : [],
    pageParams: [undefined],
  };
  queryClient.setQueryData(
    queryKeys.messages(DEMO_ACCOUNT.id, DEMO_MAILBOX.inbox),
    list,
  );
  return { registry, queryClient, list };
}

describe("previewIntent", () => {
  it("plans from cached list rows", async () => {
    const { registry, queryClient } = await setup();
    const { changes } = previewIntent(queryClient, registry, {
      accountId: DEMO_ACCOUNT.id,
      intent: { kind: "archive", ids: [asMessageId("welcome")] },
    });
    expect(changes.map((change) => change.id)).toEqual(["welcome"]);
  });

  it("falls back to known summaries for messages that left every cached list", async () => {
    const { registry, queryClient, list } = await setup();
    const welcome = list.pages[0]?.items.find((item) => item.id === "welcome");
    const archived = welcome && {
      ...welcome,
      mailboxIds: welcome.mailboxIds.filter((id) => id !== DEMO_MAILBOX.inbox),
    };
    queryClient.setQueryData(
      queryKeys.messages(DEMO_ACCOUNT.id, DEMO_MAILBOX.inbox),
      {
        ...list,
        pages: list.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== "welcome"),
        })),
      },
    );

    const intent = {
      kind: "unarchive",
      ids: [asMessageId("welcome")],
    } as const;
    expect(
      previewIntent(queryClient, registry, {
        accountId: DEMO_ACCOUNT.id,
        intent,
      }).changes,
    ).toEqual([]);
    const { changes } = previewIntent(queryClient, registry, {
      accountId: DEMO_ACCOUNT.id,
      intent,
      known: archived ? [archived] : [],
    });
    expect(changes[0]?.after.mailboxIds).toContain(DEMO_MAILBOX.inbox);
  });
});
