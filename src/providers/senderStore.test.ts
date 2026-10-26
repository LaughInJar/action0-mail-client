// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../test/memoryStorage";
import { SenderStore, sendersKey, signaturesKey } from "./senderStore";

const own = { address: "me@example.com", name: "Me" };

function store() {
  const storage = new MemoryStorage();
  return { storage, senders: new SenderStore(storage, "imap:me@example.com") };
}

describe("SenderStore", () => {
  it("lists the account's own address until others are added", () => {
    const { senders } = store();
    expect(senders.list(own)).toEqual([
      { address: "me@example.com", name: "Me", isDefault: true, signature: "" },
    ]);
    expect(senders.catchAll()).toEqual([]);
  });

  it("keeps added addresses with their settings, the own one first and exactly one default", () => {
    const { senders } = store();
    senders.save(
      own,
      [
        {
          address: "shop@family.example",
          name: "Shop",
          replyTo: { address: "desk@family.example" },
          bccSelf: true,
          isDefault: true,
        },
        { address: "info@family.example", isDefault: true },
      ],
      ["Family.example", "gmx.at"],
    );
    senders.updateSignature("Shop@family.example", "<b>Shop</b>");
    expect(senders.list(own)).toEqual([
      {
        address: "me@example.com",
        name: "Me",
        isDefault: false,
        signature: "",
      },
      {
        address: "shop@family.example",
        name: "Shop",
        isDefault: true,
        signature: "<b>Shop</b>",
        replyTo: { address: "desk@family.example" },
        bccSelf: true,
      },
      { address: "info@family.example", isDefault: false, signature: "" },
    ]);
    // Only domains of the addresses count.
    expect(senders.catchAll()).toEqual(["family.example"]);
  });

  it("drops removed addresses' signatures and follows the account's name unless changed", () => {
    const { senders, storage } = store();
    senders.save(
      own,
      [
        { address: "me@example.com", name: "Me", isDefault: true },
        { address: "old@example.com", isDefault: false },
      ],
      [],
    );
    senders.updateSignature("old@example.com", "Old");
    senders.updateSignature("me@example.com", "Mine");
    senders.save(own, [{ address: "me@example.com", isDefault: true }], []);
    expect(storage.getItem(signaturesKey("imap:me@example.com"))).toBe(
      JSON.stringify({ "me@example.com": "Mine" }),
    );
    // The name wasn't stored, so a renamed account shows its new name.
    expect(storage.getItem(sendersKey("imap:me@example.com"))).not.toContain(
      '"name"',
    );
    expect(senders.list({ ...own, name: "Renamed" })[0]?.name).toBe("Renamed");
  });

  it("refuses invalid and repeated addresses", () => {
    const { senders } = store();
    expect(() => {
      senders.save(own, [{ address: "nope", isDefault: false }], []);
    }).toThrow();
    expect(() => {
      senders.save(
        own,
        [
          { address: "a@example.com", isDefault: false },
          { address: "A@example.com", isDefault: false },
        ],
        [],
      );
    }).toThrow();
  });

  it("ignores malformed stored data", () => {
    const { senders, storage } = store();
    storage.setItem(
      sendersKey("imap:me@example.com"),
      '{"senders":[1,{"x":2}]}',
    );
    expect(senders.list(own)).toHaveLength(1);
  });
});
