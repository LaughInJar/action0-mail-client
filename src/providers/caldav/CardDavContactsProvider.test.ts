import { describe, expect, it, vi } from "vitest";
import {
  asAddressBookId,
  asContactGroupId,
  EMPTY_FIELDS,
  type Contact,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import {
  DAV_CONTACTS,
  DAV_ORIGIN,
  fakeDavServer,
  type FakeDavOptions,
} from "../../test/davServer";
import { CardDavAddressBooks } from "./contacts";
import { CardDavContactsProvider } from "./CardDavContactsProvider";
import { createCalendarServers } from "./servers";

const KEY = "imap:me@example.com";
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const anna = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
  "N:Berger;Anna;;;",
  "FN:Anna Berger",
  "item1.EMAIL;type=INTERNET;type=pref:anna@example.org",
  "item1.X-ABLabel:_$!<Other>!$_",
  "TEL;type=CELL:+43 664 123 4567",
  "CATEGORIES:Work",
  "PHOTO;ENCODING=b;TYPE=JPEG:QUJD",
  "X-SOCIALPROFILE;type=twitter:https://x.example/anna",
  "UID:anna",
  "END:VCARD",
  "",
].join("\r\n");

const max = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Max Huber",
  "N:Huber;Max;;;",
  "EMAIL:max@example.at",
  "CATEGORIES:Family,Work",
  "UID:max",
  "END:VCARD",
  "",
].join("\r\n");

const team = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Team",
  "X-ADDRESSBOOKSERVER-KIND:group",
  "END:VCARD",
  "",
].join("\r\n");

function setup(options: FakeDavOptions = {}) {
  const dav = fakeDavServer({
    connected: [KEY],
    addressBooks: {
      contacts: { "anna.vcf": anna, "max.vcf": max, "team.vcf": team },
      shared: {},
    },
    ...options,
  });
  const servers = createCalendarServers(dav.bridge);
  let now = NOW;
  const books = new CardDavAddressBooks({
    bridge: dav.bridge,
    key: KEY,
    servers,
    now: () => now,
  });
  let uids = 0;
  const provider = new CardDavContactsProvider({
    books,
    servers,
    now: () => NOW,
    uid: () => `new-${String(++uids)}`,
  });
  return {
    dav,
    servers,
    provider,
    later: () => {
      now += 60_000;
    },
  };
}

const BOOK = asAddressBookId(`${DAV_CONTACTS}contacts/`);

async function loaded(provider: CardDavContactsProvider) {
  const snapshot = await provider.load(undefined);
  const byName = (name: string): Contact => {
    const found = snapshot.contacts.find((c) => c.displayName === name);
    if (!found) throw new Error(`no ${name}`);
    return found;
  };
  return { snapshot, byName };
}

describe("CardDavContactsProvider", () => {
  it("lists the address books, their contacts and categories", async () => {
    const { provider, servers } = setup({ readOnlyBooks: ["shared"] });
    await servers.ready;
    expect(provider.access()).toBe("granted");
    const { snapshot, byName } = await loaded(provider);
    expect(snapshot.addressBooks).toEqual([
      { id: BOOK, name: "contacts", readOnly: false, isDefault: true },
      {
        id: asAddressBookId(`${DAV_CONTACTS}shared/`),
        name: "shared",
        readOnly: true,
        isDefault: false,
      },
    ]);
    // Group cards aren't people.
    expect(snapshot.contacts.map((c) => c.displayName).sort()).toEqual([
      "Anna Berger",
      "Max Huber",
    ]);
    expect(snapshot.groups.map((g) => g.name)).toEqual(["Family", "Work"]);
    const a = byName("Anna Berger");
    expect(a).toMatchObject({
      id: `${DAV_CONTACTS}contacts/anna.vcf`,
      addressBookId: BOOK,
      version: expect.any(String) as unknown,
      emails: [{ value: "anna@example.org", kind: "other" }],
      groupIds: [asContactGroupId("Work")],
      photo: { kind: "url", url: "data:image/jpeg;base64,QUJD" },
    });
    expect(await (await provider.photo(a))?.text()).toBe("ABC");
    expect(provider.rawCard(a)).toBe(anna);
  });

  it("has no access without an address book home", async () => {
    const dav = fakeDavServer({ connected: [KEY] });
    const servers = createCalendarServers(dav.bridge);
    const provider = new CardDavContactsProvider({
      books: new CardDavAddressBooks({ bridge: dav.bridge, key: KEY, servers }),
      servers,
    });
    await servers.ready;
    expect(provider.access()).toBe("missing");
    await expect(provider.requestAccess()).rejects.toMatchObject({
      reason: "contactsAccessNeeded",
    });
    expect((await provider.load(undefined)).contacts).toEqual([]);
  });

  it("creates a vCard 3.0 contact, and undo deletes it", async () => {
    const { provider, dav } = setup();
    await provider.load(undefined);
    const write = await provider.create(BOOK, {
      fields: {
        ...EMPTY_FIELDS,
        name: { given: "Lena", middle: "", family: "Huber" },
        emails: [{ value: "lena@example.org", kind: "home" }],
        groupIds: [asContactGroupId("Friends")],
      },
      photo: new Blob([new Uint8Array([65, 66, 67])], { type: "image/png" }),
    });
    const put = dav.requests.at(-1);
    expect(put).toMatchObject({
      method: "PUT",
      url: `${DAV_CONTACTS}contacts/new-1.vcf`,
      headers: { "If-None-Match": "*" },
    });
    const text = dav.cardText("contacts", "new-1.vcf") ?? "";
    expect(text).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(text).toContain("UID:new-1\r\n");
    expect(text).toContain("EMAIL;TYPE=INTERNET,HOME:lena@example.org\r\n");
    expect(text).toContain("CATEGORIES:Friends\r\n");
    expect(text).toContain("PHOTO;ENCODING=b;TYPE=PNG:QUJD\r\n");
    expect(write.contact).toMatchObject({
      displayName: "Lena Huber",
      version: expect.any(String) as unknown,
    });
    expect(await write.undo()).toBeUndefined();
    expect(dav.cardText("contacts", "new-1.vcf")).toBeUndefined();
  });

  it("changes only what changed, and undo puts the card back exactly", async () => {
    const { provider, dav } = setup();
    const { byName } = await loaded(provider);
    const a = byName("Anna Berger");
    const write = await provider.update(a, {
      ...a,
      phones: [{ value: "+43 1 000", kind: "work" }],
    });
    const changed = dav.cardText("contacts", "anna.vcf") ?? "";
    expect(changed).toContain("TEL;TYPE=WORK:+43 1 000\r\n");
    expect(changed).toContain(
      "X-SOCIALPROFILE;type=twitter:https://x.example/anna\r\n",
    );
    expect(changed).toContain("item1.X-ABLabel:_$!<Other>!$_\r\n");
    expect(dav.requests.at(-1)?.headers).toMatchObject({
      "If-Match": a.version,
    });
    expect(write.contact.phones).toEqual([
      { value: "+43 1 000", kind: "work" },
    ]);
    expect(write.contact.version).not.toBe(a.version);

    const back = await write.undo();
    expect(dav.cardText("contacts", "anna.vcf")).toBe(anna);
    expect(back?.phones).toEqual([
      { value: "+43 664 123 4567", kind: "mobile" },
    ]);
  });

  it("refuses a change over one made elsewhere, and shows that one", async () => {
    const { provider, dav } = setup();
    const { byName } = await loaded(provider);
    const a = byName("Anna Berger");
    dav.editCard(
      "contacts",
      "anna.vcf",
      anna.replace("Anna Berger", "Anna B."),
    );
    await expect(
      provider.update(a, { ...a, notes: "mine" }),
    ).rejects.toMatchObject({ reason: "contactChanged", status: 412 });
    const { byName: again } = await loaded(provider);
    expect(again("Anna B.").notes).toBe("");
  });

  it("deletes contacts, and undo restores them byte for byte", async () => {
    const { provider, dav } = setup();
    const { byName } = await loaded(provider);
    const removal = await provider.remove([
      byName("Anna Berger"),
      byName("Max Huber"),
    ]);
    expect(dav.cards("contacts")).toEqual({ "team.vcf": team });
    expect(
      dav.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(2);
    const back = await removal.undo();
    expect(back.map((c) => c.displayName)).toEqual([
      "Anna Berger",
      "Max Huber",
    ]);
    expect(dav.cardText("contacts", "anna.vcf")).toBe(anna);
    expect(dav.cardText("contacts", "max.vcf")).toBe(max);
  });

  it("puts back what it deleted when a later delete fails", async () => {
    const { provider, dav } = setup();
    const { byName } = await loaded(provider);
    const a = byName("Anna Berger");
    const m = byName("Max Huber");
    dav.editCard("contacts", "max.vcf", max.replace("Max", "Maximilian"));
    await expect(provider.remove([a, m])).rejects.toMatchObject({
      reason: "contactChanged",
    });
    expect(dav.cardText("contacts", "anna.vcf")).toBe(anna);
  });

  it("keeps read-only address books read-only", async () => {
    const { provider, dav } = setup({
      readOnlyBooks: ["contacts"],
    });
    const { byName } = await loaded(provider);
    const before = dav.requests.length;
    await expect(
      provider.update(byName("Max Huber"), {
        ...byName("Max Huber"),
        notes: "x",
      }),
    ).rejects.toMatchObject({ reason: "addressBookReadOnly" });
    await expect(
      provider.create(BOOK, { fields: EMPTY_FIELDS }),
    ).rejects.toMatchObject({ reason: "addressBookReadOnly" });
    expect(dav.requests.length).toBe(before);
  });

  it("imports cards as they are, with a UID, a few at a time", async () => {
    const { provider, dav } = setup();
    await provider.load(undefined);
    const old =
      "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane\r\nTEL;CELL:123\r\nX-CUSTOM:kept\r\nEND:VCARD\r\n";
    const progress: number[] = [];
    const results = await provider.createMany(
      BOOK,
      [
        {
          fields: {
            ...EMPTY_FIELDS,
            name: { given: "Jane", middle: "", family: "Doe" },
            phones: [{ value: "123", kind: "mobile" }],
            groupIds: [asContactGroupId("Imported")],
          },
          card: old,
        },
        { fields: { ...EMPTY_FIELDS, nickname: "Bo" } },
        { fields: EMPTY_FIELDS, card: max },
      ],
      { onProgress: (done) => progress.push(done) },
    );
    expect(progress).toEqual([1, 2, 3]);
    expect(results.some((result) => result instanceof MailError)).toBe(false);
    const jane = dav.cardText("contacts", "new-1.vcf") ?? "";
    expect(jane).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(jane).toContain("X-CUSTOM:kept\r\n");
    expect(jane).toContain("UID:new-1\r\n");
    expect(jane).toContain("CATEGORIES:Imported\r\n");
    expect(dav.cardText("contacts", "new-2.vcf")).toContain("NICKNAME:Bo");
  });

  it("learns the ETag of a write from the server when the answer has none", async () => {
    const { provider } = setup({ noEtagOnPut: true });
    const { byName } = await loaded(provider);
    const a = byName("Anna Berger");
    const first = await provider.update(a, { ...a, notes: "one" });
    expect(first.contact.version).toEqual(expect.any(String));
    const second = await provider.update(first.contact, {
      ...first.contact,
      notes: "two",
    });
    expect(second.contact.notes).toBe("two");
  });

  it("says a refused login plainly", async () => {
    const { provider, dav } = setup();
    await provider.load(undefined);
    const request = dav.bridge.request.bind(dav.bridge);
    vi.spyOn(dav.bridge, "request").mockImplementation((key, req, signal) =>
      req.method === "PUT"
        ? Promise.resolve({ status: 401, url: req.url, headers: {}, body: "" })
        : request(key, req, signal),
    );
    await expect(
      provider.create(BOOK, { fields: EMPTY_FIELDS }),
    ).rejects.toMatchObject({
      code: "auth-required",
      reason: "contactsLoginRefused",
      params: { service: new URL(DAV_ORIGIN).host },
    });
  });
});
