import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { AccountRegistryContext } from "../accounts/context";
import { asMessageId } from "../core/ids";
import type { MessageOrder } from "../core/provider";
import { createDemoData, DEMO_MAILBOX } from "../providers/fake/demoData";
import { createDemoModule, DEMO_ACCOUNT } from "../providers/fake/module";
import { queryKeys, type ListSpec } from "./keys";
import { useApplyIntent, useEmptyMailbox } from "./mutations";
import type { MessageListData } from "./optimistic";
import { createQueryClient } from "./queryClient";

/** The demo account with its mailboxes and the given lists in the cache. */
async function setup(specs: readonly ListSpec[]) {
  const data = createDemoData(Date.parse("2026-10-18T12:00:00Z"));
  const registry = new AccountRegistry({
    modules: [createDemoModule({ latencyMs: 0, data: () => data })],
    storage: undefined,
  });
  await registry.add("demo");
  const provider = registry.get(DEMO_ACCOUNT.id)?.provider;
  if (!provider) throw new Error("no demo provider");
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    queryKeys.mailboxes(DEMO_ACCOUNT.id),
    await provider.listMailboxes(),
  );
  for (const spec of specs) {
    const page = await provider.listMessages({ ...spec, limit: 50 });
    queryClient.setQueryData<MessageListData>(
      queryKeys.messageList(DEMO_ACCOUNT.id, spec),
      { pages: [page], pageParams: [undefined] },
    );
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AccountRegistryContext value={registry}>
        {children}
      </AccountRegistryContext>
    </QueryClientProvider>
  );
  const rows = (spec: ListSpec) =>
    queryClient
      .getQueryData<MessageListData>(
        queryKeys.messageList(DEMO_ACCOUNT.id, spec),
      )
      ?.pages.flatMap((page) => page.items.map((item) => item.id));
  const isStale = (spec: ListSpec) =>
    queryClient.getQueryState(queryKeys.messageList(DEMO_ACCOUNT.id, spec))
      ?.isInvalidated;
  return { queryClient, wrapper, rows, isStale };
}

const inbox = (order: MessageOrder = "newest"): ListSpec => ({
  mailboxId: DEMO_MAILBOX.inbox,
  order,
});
const inboxSearch: ListSpec = {
  mailboxId: DEMO_MAILBOX.inbox,
  search: "logo draft",
  order: "newest",
};
const LOGO = asMessageId("inline-image");

describe("changes and search results", () => {
  it("patches search results like the mailbox, then marks them stale", async () => {
    const { wrapper, rows, isStale } = await setup([
      inbox(),
      inbox("oldest"),
      inboxSearch,
    ]);
    expect(rows(inboxSearch)).toEqual([LOGO]);
    const { result } = renderHook(() => useApplyIntent(), { wrapper });

    await result.current.mutateAsync({
      accountId: DEMO_ACCOUNT.id,
      intent: { kind: "archive", ids: [LOGO] },
    });
    expect(rows(inboxSearch)).toEqual([]);
    expect(rows(inbox())).not.toContain(LOGO);
    expect(rows(inbox("oldest"))).not.toContain(LOGO);
    // Whether a message still matches is the provider's call.
    expect(isStale(inboxSearch)).toBe(true);
    expect(isStale(inbox())).toBe(false);
  });

  it("empties every list of the mailbox, searched ones included", async () => {
    const trash: ListSpec = { mailboxId: DEMO_MAILBOX.trash, order: "newest" };
    const trashSearch: ListSpec = { ...trash, search: "standup" };
    const { wrapper, rows } = await setup([trash, trashSearch]);
    expect(rows(trashSearch)).toHaveLength(1);
    const { result } = renderHook(() => useEmptyMailbox(), { wrapper });

    await result.current.mutateAsync({
      accountId: DEMO_ACCOUNT.id,
      mailboxId: DEMO_MAILBOX.trash,
    });
    expect(rows(trash)).toEqual([]);
    expect(rows(trashSearch)).toEqual([]);
  });
});
