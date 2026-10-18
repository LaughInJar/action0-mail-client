// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { StaticAuthSession } from "../auth/staticSession";
import { asAccountId } from "../core/ids";
import type { Account } from "../core/model";
import { createDemoData } from "../providers/fake/demoData";
import { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { MemoryStorage } from "../test/memoryStorage";
import { ACCOUNTS_KEY, loadAccounts } from "./accountStorage";
import { AccountRegistry } from "./AccountRegistry";
import type { ProviderModule } from "./types";

const jane: Account = {
  id: asAccountId("gmail:jane@example.com"),
  type: "gmail",
  email: "jane@example.com",
};

function gmailLikeModule(
  account = jane,
): ProviderModule & { sessions: StaticAuthSession[] } {
  const sessions: StaticAuthSession[] = [];
  const session = () => {
    const created = new StaticAuthSession("signed-in", "secret-token");
    sessions.push(created);
    return created;
  };
  return {
    type: "gmail",
    label: "Gmail",
    sessions,
    connect: () => Promise.resolve({ account, auth: session() }),
    restore: session,
    createProvider: () => new FakeMailProvider(createDemoData(0)),
  };
}

describe("AccountRegistry", () => {
  it("persists accounts without any credentials and restores them", async () => {
    const storage = new MemoryStorage();
    const registry = new AccountRegistry({
      modules: [gmailLikeModule()],
      storage,
    });
    await registry.add("gmail");
    expect(storage.dump()).not.toContain("secret-token");
    expect(JSON.parse(storage.getItem(ACCOUNTS_KEY) ?? "")).toEqual([
      { id: jane.id, type: "gmail", email: jane.email },
    ]);

    const restored = new AccountRegistry({
      modules: [gmailLikeModule()],
      storage,
    });
    restored.restore();
    expect(restored.list().map((h) => h.account)).toEqual([jane]);
  });

  it("replaces the session when an account is added again", async () => {
    const module = gmailLikeModule();
    const registry = new AccountRegistry({
      modules: [module],
      storage: undefined,
    });
    await registry.add("gmail");
    const second = await registry.add("gmail");
    expect(registry.list()).toEqual([second]);
    expect(second.auth).toBe(module.sessions[1]);
  });

  it("signs out, forgets the account and reports the removal", async () => {
    const onRemove = vi.fn();
    const storage = new MemoryStorage();
    const registry = new AccountRegistry({
      modules: [gmailLikeModule()],
      storage,
      onRemove,
    });
    const handle = await registry.add("gmail");
    const listener = vi.fn();
    registry.subscribe(listener);
    await registry.remove(jane.id);
    expect(registry.list()).toEqual([]);
    expect(handle.auth.status).toBe("signed-out");
    expect(onRemove).toHaveBeenCalledWith(jane.id);
    expect(listener).toHaveBeenCalled();
    expect(loadAccounts(storage)).toEqual([]);
  });

  it("ignores persisted accounts without a module and malformed entries", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      ACCOUNTS_KEY,
      JSON.stringify([
        { id: "x", type: "imap", email: "a@b" },
        { id: 1 },
        { id: jane.id, type: "gmail", email: jane.email },
      ]),
    );
    const registry = new AccountRegistry({
      modules: [gmailLikeModule()],
      storage,
    });
    registry.restore();
    expect(registry.list().map((h) => h.account.id)).toEqual([jane.id]);
  });

  it("keeps accounts of unregistered providers and loads them once registered", async () => {
    const storage = new MemoryStorage();
    await new AccountRegistry({ modules: [gmailLikeModule()], storage }).add(
      "gmail",
    );

    // Next start: Google isn't configured yet.
    const registry = new AccountRegistry({ modules: [], storage });
    registry.restore();
    expect(registry.list()).toEqual([]);
    expect(loadAccounts(storage)).toEqual([jane]);

    const listener = vi.fn();
    registry.subscribe(listener);
    const modulesBefore = registry.availableModules();
    registry.registerModule(gmailLikeModule());
    expect(registry.hasModule("gmail")).toBe(true);
    expect(registry.availableModules()).not.toBe(modulesBefore);
    expect(registry.list().map((h) => h.account)).toEqual([jane]);
    expect(listener).toHaveBeenCalled();
  });
});
