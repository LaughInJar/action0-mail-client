// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gmailLabel } from "../../test/gmailFixtures";
import {
  ALL_MAIL_ID,
  CATEGORIES_ID,
  isMappedLabel,
  isMembershipLabel,
  mapLabels,
} from "./labels";

const SYSTEM = [
  "TRASH",
  "SPAM",
  "DRAFT",
  "SENT",
  "IMPORTANT",
  "STARRED",
  "INBOX",
  "UNREAD",
  "CHAT",
];

describe("mapLabels", () => {
  it("orders system mailboxes and adds the All Mail view", () => {
    const mailboxes = mapLabels(
      SYSTEM.filter((id) => id !== "UNREAD" && id !== "CHAT").map((id) =>
        gmailLabel(id),
      ),
    );
    expect(mailboxes.map((m) => [m.name, m.kind, m.role])).toEqual([
      ["Inbox", "label", "inbox"],
      ["Starred", "view", "flagged"],
      ["Important", "label", "important"],
      ["Sent", "label", "sent"],
      ["Drafts", "label", "drafts"],
      ["All Mail", "view", "all"],
      ["Spam", "label", "junk"],
      ["Trash", "label", "trash"],
    ]);
    expect(mailboxes.find((m) => m.role === "all")?.id).toBe(ALL_MAIL_ID);
  });

  it("groups categories under a non-selectable node", () => {
    const mailboxes = mapLabels([
      gmailLabel("CATEGORY_SOCIAL"),
      gmailLabel("CATEGORY_PERSONAL"),
    ]);
    const group = mailboxes.find((m) => m.id === CATEGORIES_ID);
    expect(group).toMatchObject({ name: "Categories", selectable: false });
    expect(
      mailboxes.filter((m) => m.parentId === CATEGORIES_ID).map((m) => m.name),
    ).toEqual(["Primary", "Social"]);
  });

  it("nests user labels, sorts them naturally and synthesizes missing parents", () => {
    const mailboxes = mapLabels([
      gmailLabel("Label_3", { name: "Work/Clients/Acme" }),
      gmailLabel("Label_1", { name: "Work" }),
      gmailLabel("Label_10", { name: "Project 10" }),
      gmailLabel("Label_2", { name: "Project 2" }),
      gmailLabel("Label_4", { name: "Travel/2026" }),
    ]);
    const byName = new Map(mailboxes.map((m) => [m.name, m]));
    expect(
      mailboxes
        .filter((m) => m.role === undefined && m.id !== ALL_MAIL_ID)
        .map((m) => m.name),
    ).toEqual([
      "Project 2",
      "Project 10",
      "Travel",
      "2026",
      "Work",
      "Clients",
      "Acme",
    ]);
    expect(byName.get("Acme")?.parentId).toBe(byName.get("Clients")?.id);
    expect(byName.get("Clients")).toMatchObject({
      selectable: false,
      parentId: "Label_1",
    });
    expect(byName.get("Travel")).toMatchObject({ selectable: false });
  });

  it("maps counts, colors and list visibility", () => {
    const [hidden, ifUnread, shown] = mapLabels([
      gmailLabel("Label_1", { name: "A", labelListVisibility: "labelHide" }),
      gmailLabel("Label_2", {
        name: "B",
        labelListVisibility: "labelShowIfUnread",
        messagesUnread: 0,
      }),
      gmailLabel("Label_3", {
        name: "C",
        messagesUnread: 3,
        messagesTotal: 7,
        color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
      }),
    ]).filter((m) => m.role === undefined && m.id !== ALL_MAIL_ID);
    expect(hidden?.hidden).toBe(true);
    expect(ifUnread?.hidden).toBe(true);
    expect(shown).toMatchObject({
      hidden: false,
      counts: { unread: 3, total: 7 },
      color: { background: "#4a86e8", text: "#ffffff" },
    });
  });
});

describe("label classification", () => {
  it("keeps flags out of mailbox memberships", () => {
    expect(isMembershipLabel("INBOX")).toBe(true);
    expect(isMembershipLabel("Label_1")).toBe(true);
    expect(isMembershipLabel("UNREAD")).toBe(false);
    expect(isMembershipLabel("STARRED")).toBe(false);
  });

  it("only maps known system labels, categories and user labels", () => {
    expect(isMappedLabel(gmailLabel("INBOX"))).toBe(true);
    expect(isMappedLabel(gmailLabel("CATEGORY_UPDATES"))).toBe(true);
    expect(isMappedLabel(gmailLabel("Label_1"))).toBe(true);
    expect(isMappedLabel(gmailLabel("UNREAD"))).toBe(false);
    expect(isMappedLabel(gmailLabel("CHAT"))).toBe(false);
  });
});
