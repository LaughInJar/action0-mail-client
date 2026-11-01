// @vitest-environment node
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import type { ScopedSession } from "../../auth/types";
import {
  asAddressBookId,
  asContactGroupId,
  EMPTY_FIELDS,
  fieldsOf,
  type Contact,
  type ContactFields,
  type ContactSnapshot,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import { FakeGraph } from "../../test/graphServer";
import { birthdayOf, graphBirthday, GraphContactsProvider } from "./contacts";
import { GraphHttp } from "./http";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function setup(options: { granted?: boolean } = {}) {
  const graph = new FakeGraph();
  server.use(...graph.handlers());
  let granted = options.granted ?? true;
  const listeners = new Set<() => void>();
  const session: ScopedSession = {
    hasScopes: () => granted,
    requestScopes: () => {
      granted = true;
      for (const listener of listeners) listener();
      return Promise.resolve();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const provider = new GraphContactsProvider(
    new GraphHttp({
      auth: new StaticAuthSession(),
      sleep: () => Promise.resolve(),
    }),
    session,
  );
  return { graph, provider };
}

const DEFAULT = asAddressBookId("contacts");

const fields = (changes: Partial<ContactFields> = {}): ContactFields => ({
  ...EMPTY_FIELDS,
  name: { given: "Anna", middle: "", family: "Berger" },
  emails: [{ value: "anna@example.com", kind: "other" }],
  ...changes,
});

const byName = (snapshot: ContactSnapshot, name: string): Contact => {
  const found = snapshot.contacts.find((c) => c.displayName === name);
  if (!found) throw new Error(`no contact ${name}`);
  return found;
};

describe("GraphContactsProvider", () => {
  it("lists the default folder and its sub-folders with their contacts", async () => {
    const { graph, provider } = setup();
    graph.addContactFolder("suppliers-id", "Suppliers");
    graph.addContactFolder("print-id", "Print", "suppliers-id");
    graph.categories.push({ id: "c1", displayName: "Team", color: "preset7" });
    graph.addContact({
      givenName: "Anna",
      surname: "Berger",
      displayName: "Anna Berger",
      emailAddresses: [{ name: "Anna", address: "anna@example.com" }],
      mobilePhone: "+43 664 1",
      homePhones: ["+43 1 2"],
      businessPhones: ["+43 1 3", "+43 1 4"],
      companyName: "Berger & Partner",
      jobTitle: "Lead",
      homeAddress: {
        street: "Neubaugasse 12",
        city: "Vienna",
        postalCode: "1070",
        countryOrRegion: "Austria",
      },
      birthday: "1988-03-13T23:00:00Z",
      businessHomePage: "https://berger.example",
      personalNotes: "Calls in the morning.",
      categories: ["Team", "Old"],
    });
    graph.addContact({ displayName: "Kaiser" }, "print-id");

    const snapshot = await provider.load(undefined);

    expect(snapshot.addressBooks.map((book) => book.name)).toEqual([
      "Contacts",
      "Suppliers",
      "Print",
    ]);
    expect(snapshot.addressBooks[0]).toMatchObject({
      id: DEFAULT,
      isDefault: true,
    });
    const anna = byName(snapshot, "Anna Berger");
    expect(anna.addressBookId).toBe(DEFAULT);
    expect(anna.emails).toEqual([{ value: "anna@example.com", kind: "other" }]);
    expect(anna.phones.map((p) => p.kind)).toEqual([
      "mobile",
      "home",
      "work",
      "work",
    ]);
    expect(anna.addresses).toEqual([
      {
        street: "Neubaugasse 12",
        city: "Vienna",
        region: "",
        postalCode: "1070",
        country: "Austria",
        kind: "home",
      },
    ]);
    // Midnight in Vienna, stored as the evening before in UTC.
    expect(anna.birthday).toEqual({ year: 1988, month: 3, day: 14 });
    expect(anna.websites).toEqual([
      { value: "https://berger.example", kind: "work" },
    ]);
    expect(anna.groupIds).toEqual(["Team", "Old"]);
    expect(anna.photo).toEqual({ kind: "fetch" });
    expect(anna.version).toMatch(/^W\/"ck-/);
    expect(byName(snapshot, "Kaiser").addressBookId).toBe("print-id");
    // The category without a master entry shows too, without colour.
    expect(snapshot.groups).toEqual([
      { id: "Team", name: "Team", color: "#4cb4e7" },
      { id: "Old", name: "Old" },
    ]);
  });

  it("brings what changed since the last load, through delta links", async () => {
    const { graph, provider } = setup();
    graph.addContactFolder("suppliers-id", "Suppliers");
    const anna = graph.addContact({ displayName: "Anna", givenName: "Anna" });
    const max = graph.addContact({ displayName: "Max", givenName: "Max" });
    const first = await provider.load(undefined);
    expect(first.contacts).toHaveLength(2);

    graph.changeContact(anna.id, { displayName: "Anna B." });
    graph.removeContact(max.id);
    graph.addContact({ displayName: "Lena" }, "suppliers-id");
    const before = graph.seen.length;
    const second = await provider.load(first);

    expect(second.contacts.map((c) => c.displayName).sort()).toEqual([
      "Anna B.",
      "Lena",
    ]);
    // Only delta rounds with a token, no new listing.
    const lists = graph.seen
      .slice(before)
      .filter((r) => /contacts(\/delta)?$/.test(r.path));
    expect(lists.every((r) => r.query.has("$deltatoken"))).toBe(true);
  });

  it("follows the pages of a delta round", async () => {
    const { graph, provider } = setup();
    for (let n = 0; n < 205; n++) graph.addContact({ displayName: `P${n}` });
    const snapshot = await provider.load(undefined);
    expect(snapshot.contacts).toHaveLength(205);
    expect(
      graph.requests("GET", /contactFolders\/contacts-id\/contacts\/delta/),
    ).toHaveLength(2);
  });

  it("loads everything again when a delta link expired or delta is refused", async () => {
    const { graph, provider } = setup();
    graph.addContact({ displayName: "Anna" });
    const first = await provider.load(undefined);
    graph.addContact({ displayName: "Max" });
    graph.expireContactDelta = true;
    const second = await provider.load(first);
    expect(second.contacts).toHaveLength(2);

    graph.contactDeltaFails = true;
    graph.addContact({ displayName: "Lena" });
    const third = await provider.load(second);
    expect(third.contacts).toHaveLength(3);
    expect(graph.requests("GET", /^me\/contacts$/).length).toBeGreaterThan(0);
  });

  it("lists the default folder plainly while its id is unknown", async () => {
    const { graph, provider } = setup();
    const snapshot = await provider.load(undefined);
    expect(snapshot.contacts).toEqual([]);
    expect(snapshot.addressBooks.map((book) => book.id)).toEqual([DEFAULT]);
    expect(graph.requests("GET", /delta$/)).toHaveLength(0);
  });

  it("creates contacts with their photo, and undo deletes them", async () => {
    const { graph, provider } = setup();
    const photo = new Blob(["jpeg"], { type: "image/jpeg" });
    const write = await provider.create(DEFAULT, {
      fields: fields({
        phones: [
          { value: "1", kind: "mobile" },
          { value: "2", kind: "other" },
        ],
        birthday: { year: 1990, month: 5, day: 1 },
        groupIds: [asContactGroupId("Team")],
      }),
      photo,
    });

    const stored = graph.contacts[0];
    expect(stored).toMatchObject({
      displayName: "Anna Berger",
      givenName: "Anna",
      surname: "Berger",
      mobilePhone: "1",
      // "other" has no place in Outlook: it goes where there's room.
      homePhones: ["2"],
      birthday: "1990-05-01T11:59:00Z",
      categories: ["Team"],
      emailAddresses: [{ address: "anna@example.com", name: "Anna Berger" }],
    });
    expect(await stored?.photo?.text()).toBe("jpeg");
    expect(write.contact.birthday).toEqual({ year: 1990, month: 5, day: 1 });
    expect(await provider.photo(write.contact)).toBeInstanceOf(Blob);

    await write.undo();
    expect(graph.contacts).toEqual([]);
  });

  it("creates many through $batch, into a folder, with progress", async () => {
    const { graph, provider } = setup();
    graph.addContactFolder("suppliers-id", "Suppliers");
    const progress: number[] = [];
    const results = await provider.createMany(
      asAddressBookId("suppliers-id"),
      Array.from({ length: 25 }, (_, n) => ({
        fields: fields({
          name: { given: `P${String(n)}`, middle: "", family: "" },
        }),
      })),
      { onProgress: (done) => progress.push(done) },
    );
    expect(results).toHaveLength(25);
    expect(results.every((r) => !(r instanceof MailError))).toBe(true);
    expect(progress).toEqual([20, 25]);
    expect(
      graph.contacts.every((c) => c.parentFolderId === "suppliers-id"),
    ).toBe(true);
    expect(graph.requests("POST", /contacts$/).every((r) => r.batched)).toBe(
      true,
    );
  });

  it("changes only what changed, with If-Match, and undo puts it back", async () => {
    const { graph, provider } = setup();
    graph.addContact({
      givenName: "Anna",
      surname: "Berger",
      displayName: "Anna Berger",
      emailAddresses: [{ address: "anna@example.com" }],
      jobTitle: "Lead",
      spouseName: "Max",
    } as never);
    const anna = byName(await provider.load(undefined), "Anna Berger");

    const write = await provider.update(anna, {
      ...fieldsOf(anna),
      organization: { company: "", title: "Head", department: "" },
      notes: "New note",
    });

    const patch = graph.requests("PATCH", /^me\/contacts\//)[0];
    expect(patch?.body).toEqual({
      companyName: null,
      jobTitle: "Head",
      department: null,
      personalNotes: "New note",
    });
    expect(patch?.headers["if-match"]).toBe(anna.version);
    expect(write.contact.organization.title).toBe("Head");
    expect(graph.contacts[0]).toMatchObject({ spouseName: "Max" });

    const back = await write.undo();
    expect(back?.organization.title).toBe("Lead");
    expect(graph.contacts[0]?.personalNotes).toBe("");
  });

  it("renames the display name with the name", async () => {
    const { graph, provider } = setup();
    graph.addContact({
      givenName: "Anna",
      surname: "Berger",
      displayName: "Anna Berger",
    });
    const anna = byName(await provider.load(undefined), "Anna Berger");
    await provider.update(anna, {
      ...fieldsOf(anna),
      name: { given: "Anna", middle: "", family: "Huber" },
    });
    expect(graph.contacts[0]).toMatchObject({
      surname: "Huber",
      displayName: "Anna Huber",
    });
  });

  it("says when a contact changed elsewhere or is gone", async () => {
    const { graph, provider } = setup();
    const stored = graph.addContact({ displayName: "Anna", givenName: "Anna" });
    const anna = byName(await provider.load(undefined), "Anna");
    graph.changeContact(stored.id, { jobTitle: "Elsewhere" });

    const changed = await provider
      .update(anna, { ...fieldsOf(anna), notes: "x" })
      .catch((error: unknown) => error);
    expect(changed).toMatchObject({ reason: "contactChanged", status: 412 });

    graph.removeContact(stored.id);
    const gone = await provider
      .update(withoutVersion(anna), { ...fieldsOf(anna), notes: "x" })
      .catch((error: unknown) => error);
    expect(gone).toMatchObject({ code: "not-found", reason: "contactGone" });
  });

  it("deletes contacts and brings them back whole, photo included", async () => {
    const { graph, provider } = setup();
    graph.addContactFolder("suppliers-id", "Suppliers");
    const stored = graph.addContact(
      {
        givenName: "Anna",
        displayName: "Anna",
        spouseName: "Max",
        categories: ["Team"],
      } as never,
      "suppliers-id",
    );
    stored.photo = new Blob(["png"], { type: "image/png" });
    graph.addContact({ displayName: "Max", givenName: "Max" });
    const snapshot = await provider.load(undefined);

    const removal = await provider.remove(snapshot.contacts);
    expect(graph.contacts).toEqual([]);

    const restored = await removal.undo();
    expect(restored.map((c) => c.displayName).sort()).toEqual(["Anna", "Max"]);
    const anna = graph.contacts.find((c) => c.displayName === "Anna");
    expect(anna).toMatchObject({
      parentFolderId: "suppliers-id",
      spouseName: "Max",
      categories: ["Team"],
    });
    expect(anna?.id).not.toBe(stored.id);
    expect(await anna?.photo?.text()).toBe("png");
    expect(restored.find((c) => c.displayName === "Anna")?.addressBookId).toBe(
      "suppliers-id",
    );
  });

  it("deletes a contact that's already gone without complaint", async () => {
    const { graph, provider } = setup();
    const stored = graph.addContact({ displayName: "Anna" });
    const anna = byName(await provider.load(undefined), "Anna");
    graph.removeContact(stored.id);
    await expect(provider.remove([anna])).resolves.toBeDefined();
  });

  it("creates groups as categories, and finds existing ones", async () => {
    const { graph, provider } = setup();
    const team = await provider.createGroup(" Team ");
    expect(team).toMatchObject({ id: "Team", name: "Team" });
    expect(team.color).toMatch(/^#/);
    expect(graph.categories.map((c) => c.displayName)).toEqual(["Team"]);
    await expect(provider.createGroup("Team")).resolves.toMatchObject({
      name: "Team",
    });
  });

  it("has no photo where Outlook has none", async () => {
    const { graph, provider } = setup();
    graph.addContact({ displayName: "Anna" });
    const anna = byName(await provider.load(undefined), "Anna");
    await expect(provider.photo(anna)).resolves.toBeUndefined();
  });

  it("asks for access through the session", async () => {
    const { provider } = setup({ granted: false });
    expect(provider.access()).toBe("missing");
    let told = 0;
    provider.subscribe(() => told++);
    await provider.requestAccess();
    expect(provider.access()).toBe("granted");
    expect(told).toBe(1);
  });
});

describe("Outlook birthdays", () => {
  it("reads the nearest day, whatever time zone wrote it", () => {
    expect(birthdayOf("1988-03-13T23:00:00Z")).toEqual({
      year: 1988,
      month: 3,
      day: 14,
    });
    expect(birthdayOf("1988-03-14T11:59:00Z")).toEqual({
      year: 1988,
      month: 3,
      day: 14,
    });
    expect(birthdayOf("1988-03-14T05:00:00Z")).toEqual({
      year: 1988,
      month: 3,
      day: 14,
    });
    expect(birthdayOf(null)).toBeUndefined();
  });

  it("writes just before noon, and nothing without a year", () => {
    expect(graphBirthday({ year: 1988, month: 3, day: 14 })).toBe(
      "1988-03-14T11:59:00Z",
    );
    expect(graphBirthday({ month: 3, day: 14 })).toBeNull();
  });
});

/** A contact as if read without a version (no `If-Match`). */
function withoutVersion(contact: Contact): Contact {
  const { version: _version, ...rest } = contact;
  return rest;
}
