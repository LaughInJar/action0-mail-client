// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  focusViews,
  inboxListOf,
  isFocusView,
  isSplit,
  ruleChangesBack,
  withRuleChanges,
} from "./focus";
import { asMailboxId } from "./ids";
import type { Mailbox } from "./model";

const box = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id: asMailboxId(id),
  name: id,
  kind: "folder",
  selectable: true,
  hidden: false,
  assignable: true,
  ...extra,
});
const inbox = box("inbox", { role: "inbox" });
const focused = box("focused", {
  kind: "view",
  standard: "focused",
  parentId: inbox.id,
  hidden: true,
});
const other = (total: number) =>
  box("other", {
    kind: "view",
    standard: "other",
    parentId: inbox.id,
    hidden: true,
    counts: { total, unread: 0 },
  });

describe("Focused Inbox", () => {
  it("is split by the switch, else once Outlook put mail into Other", () => {
    expect(focusViews([inbox])).toBeUndefined();
    expect(isSplit([inbox], true)).toBe(false);
    expect(isSplit([inbox, focused, other(0)], undefined)).toBe(false);
    expect(isSplit([inbox, focused, other(3)], undefined)).toBe(true);
    expect(isSplit([inbox, focused, other(3)], false)).toBe(false);
    expect(isSplit([inbox, focused, other(0)], true)).toBe(true);
  });

  it("stands for Focused when split, else the Inbox", () => {
    expect(inboxListOf([inbox, focused, other(3)], undefined)).toBe(focused);
    expect(inboxListOf([inbox, focused, other(3)], false)).toBe(inbox);
    expect(inboxListOf([inbox], undefined)).toBe(inbox);
    expect(isFocusView(focused)).toBe(true);
    expect(isFocusView(inbox)).toBe(false);
  });

  it("changes sender rules by address, and knows how to put them back", () => {
    const rules = [
      { address: "News@contoso.example", name: "Contoso", focus: "other" },
      { address: "anna@example.org", focus: "focused" },
    ] as const;
    const changes = [
      { address: "news@contoso.example", focus: "focused" },
      { address: "anna@example.org", focus: null },
      { address: "max@example.org", focus: "other" },
    ] as const;
    expect(withRuleChanges(rules, changes)).toEqual([
      { address: "max@example.org", focus: "other" },
      { address: "news@contoso.example", name: "Contoso", focus: "focused" },
    ]);
    expect(ruleChangesBack(rules, changes)).toEqual([
      { address: "news@contoso.example", focus: "other" },
      { address: "anna@example.org", focus: "focused" },
      { address: "max@example.org", focus: null },
    ]);
  });
});
