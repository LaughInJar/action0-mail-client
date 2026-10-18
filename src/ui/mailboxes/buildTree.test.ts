// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asMailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { badgeCount, buildMailboxTree, type MailboxNode } from "./buildTree";

const mailbox = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id: asMailboxId(id),
  name: id,
  kind: "label",
  selectable: true,
  hidden: false,
  ...extra,
});

const names = (nodes: readonly MailboxNode[]): unknown[] =>
  nodes.map((node) =>
    node.children.length
      ? [node.mailbox.name, names(node.children)]
      : node.mailbox.name,
  );

describe("buildMailboxTree", () => {
  it("puts role mailboxes first in role order and keeps the provider order otherwise", () => {
    const tree = buildMailboxTree([
      mailbox("zeta"),
      mailbox("trash", { role: "trash" }),
      mailbox("alpha"),
      mailbox("inbox", { role: "inbox" }),
      mailbox("sent", { role: "sent" }),
    ]);
    expect(names(tree)).toEqual(["inbox", "sent", "trash", "zeta", "alpha"]);
  });

  it("nests children and hides hidden branches", () => {
    const tree = buildMailboxTree([
      mailbox("work"),
      mailbox("clients", { parentId: asMailboxId("work") }),
      mailbox("old", { hidden: true }),
      mailbox("old-child", { parentId: asMailboxId("old") }),
      mailbox("orphan", { parentId: asMailboxId("missing") }),
    ]);
    expect(names(tree)).toEqual([["work", ["clients"]], "orphan"]);
  });

  it("drops empty grouping nodes and survives parent cycles", () => {
    const tree = buildMailboxTree([
      mailbox("group", { selectable: false }),
      mailbox("a", { parentId: asMailboxId("b") }),
      mailbox("b", { parentId: asMailboxId("a") }),
    ]);
    expect(names(tree)).toEqual([]);
  });
});

describe("badgeCount", () => {
  it("counts drafts in total, most mailboxes unread, and some not at all", () => {
    const counts = { unread: 2, total: 5 };
    expect(badgeCount(mailbox("d", { role: "drafts", counts }))).toBe(5);
    expect(badgeCount(mailbox("i", { role: "inbox", counts }))).toBe(2);
    expect(badgeCount(mailbox("s", { role: "sent", counts }))).toBeUndefined();
    expect(
      badgeCount(mailbox("l", { counts: { unread: 0, total: 5 } })),
    ).toBeUndefined();
    expect(badgeCount(mailbox("x"))).toBeUndefined();
  });
});
