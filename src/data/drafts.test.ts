import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import type { ComposerContent } from "../compose/session";
import { createDemoData, DEMO_MAILBOX } from "../providers/fake/demoData";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { createDemoModule, DEMO_ACCOUNT } from "../providers/fake/module";
import { createDraftSync } from "./drafts";
import { createQueryClient } from "./queryClient";

async function setup() {
  const data = createDemoData(Date.parse("2026-10-18T12:00:00Z"));
  const registry = new AccountRegistry({
    modules: [createDemoModule({ latencyMs: 5, data: () => data })],
    storage: undefined,
  });
  await registry.add("demo");
  const provider = registry.get(DEMO_ACCOUNT.id)?.provider as FakeMailProvider;
  const sync = createDraftSync(createQueryClient(), registry);
  const subjects = async (mailboxId: typeof DEMO_MAILBOX.drafts) =>
    (await provider.listMessages({ mailboxId, limit: 50 })).items.map(
      (m) => m.subject,
    );
  return { sync, subjects };
}

const content = (subject: string): ComposerContent => ({
  to: [{ address: "anna@example.org" }],
  cc: [],
  bcc: [],
  subject,
  body: "<p>Hi</p>",
  attachments: [],
});

describe("DraftSync", () => {
  it("never makes two drafts for one composer, even when saves overlap", async () => {
    const { sync, subjects } = await setup();
    const first = sync.save(1, DEMO_ACCOUNT.id, content("One"), undefined);
    const second = sync.save(1, DEMO_ACCOUNT.id, content("Two"), undefined);
    const [a, b] = await Promise.all([first, second]);
    expect(b.id).toBe(a.id);
    const drafts = await subjects(DEMO_MAILBOX.drafts);
    expect(drafts).toContain("Two");
    expect(drafts).not.toContain("One");
  });

  it("sends the draft a running save creates, and leaves no draft behind", async () => {
    const { sync, subjects } = await setup();
    void sync.save(2, DEMO_ACCOUNT.id, content("Draft"), undefined);
    await sync.send(2, DEMO_ACCOUNT.id, content("Final"), undefined);
    expect(await subjects(DEMO_MAILBOX.drafts)).not.toContain("Draft");
    expect(await subjects(DEMO_MAILBOX.drafts)).not.toContain("Final");
    expect(await subjects(DEMO_MAILBOX.sent)).toContain("Final");
  });

  it("discards the draft a running save creates", async () => {
    const { sync, subjects } = await setup();
    void sync.save(3, DEMO_ACCOUNT.id, content("Gone"), undefined);
    await sync.discard(3, DEMO_ACCOUNT.id, undefined);
    expect(await subjects(DEMO_MAILBOX.drafts)).not.toContain("Gone");
  });
});
