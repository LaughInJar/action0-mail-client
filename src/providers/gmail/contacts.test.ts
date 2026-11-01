// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import type { AuthSession, ScopedSession } from "../../auth/types";
import {
  asContactGroupId,
  EMPTY_FIELDS,
  fieldsOf,
  type Contact,
  type ContactFields,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import {
  CONTACTS_READ_SCOPE,
  CONTACTS_WRITE_SCOPE,
  contactOf,
  GoogleContactsProvider,
  OTHER_CONTACTS_SCOPE,
} from "./contacts";
import { GmailHttp, PEOPLE_API_BASE } from "./http";
import type { PeoplePerson } from "./types";

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

const ALL = [CONTACTS_READ_SCOPE, OTHER_CONTACTS_SCOPE, CONTACTS_WRITE_SCOPE];
const PHOTO = "https://lh3.googleusercontent.com/contacts/anna=s100";

/** A session that has these scopes; asking adds what `grants` allows. */
function scoped(scopes: readonly string[], grants: readonly string[] = []) {
  const granted = new Set(scopes);
  const asked: string[][] = [];
  const session = {
    hasScopes: (wanted: readonly string[]) =>
      wanted.every((scope) => granted.has(scope)),
    requestScopes: (wanted: readonly string[]) => {
      asked.push([...wanted]);
      for (const scope of wanted)
        if (grants.includes(scope)) granted.add(scope);
      return wanted.every((scope) => granted.has(scope))
        ? Promise.resolve()
        : Promise.reject(
            new MailError("unavailable", "Declined.", {
              reason: "accessNotGranted",
            }),
          );
    },
    subscribe: () => () => undefined,
  } as unknown as AuthSession & ScopedSession;
  return { session, asked };
}

function provider(scopes: readonly string[] = ALL) {
  return new GoogleContactsProvider(
    new GmailHttp({
      auth: new StaticAuthSession(),
      baseUrl: PEOPLE_API_BASE,
      service: "Google Contacts",
      sleep: () => Promise.resolve(),
    }),
    scoped(scopes).session,
  );
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: unknown;
}

type Route = (request: Seen) => unknown;

/**
 * Answers People API requests by "METHOD path" (path below `/v1/`); a
 * route returns JSON, a Response, or undefined for an empty answer.
 * Unknown requests fail the test.
 */
function serve(routes: Record<string, Route>): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.all(`${PEOPLE_API_BASE}*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.replace(/^\/v1\//, ""));
      const text = await request.text();
      const one: Seen = {
        method: request.method,
        path,
        params: url.searchParams,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
      seen.push(one);
      const route = routes[`${request.method} ${path}`];
      if (!route)
        return HttpResponse.json(
          { error: { message: `Unexpected ${request.method} ${path}` } },
          { status: 501 },
        );
      const answer = route(one);
      if (answer instanceof Response) return answer;
      return answer === undefined
        ? new HttpResponse(null, { status: 200 })
        : HttpResponse.json(answer as Record<string, unknown>);
    }),
    http.get("https://lh3.googleusercontent.com/*", () =>
      HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
        headers: { "Content-Type": "image/jpeg" },
      }),
    ),
  );
  return seen;
}

const contactSource = { metadata: { source: { type: "CONTACT", id: "1" } } };

/** Anna, as Google keeps her: custom types, a linked profile's data, labels. */
const ANNA: PeoplePerson = {
  resourceName: "people/c1",
  etag: "e1",
  metadata: { sources: [{ type: "CONTACT", id: "1", etag: "s1" }] },
  names: [
    {
      displayName: "Anna Berger",
      givenName: "Anna",
      familyName: "Berger",
      metadata: { primary: true, source: { type: "CONTACT", id: "1" } },
    },
  ],
  emailAddresses: [
    { value: "anna@example.org", type: "work", ...contactSource },
    {
      value: "anna@uni.example",
      type: "school",
      formattedType: "School",
      ...contactSource,
    },
    {
      value: "anna.profile@example.com",
      metadata: { source: { type: "PROFILE", id: "9" } },
    },
  ],
  phoneNumbers: [
    {
      value: "+43 664 1234567",
      type: "mobile",
      canonicalForm: "+436641234567",
    },
    { value: "+43 1 999", type: "workFax", formattedType: "Work fax" },
  ],
  organizations: [
    { name: "Berger & Partner", title: "Lead", department: "Ops" },
  ],
  addresses: [
    {
      streetAddress: "Neubaugasse 12",
      city: "Vienna",
      postalCode: "1070",
      country: "Austria",
      type: "home",
      formattedValue: "Neubaugasse 12\n1070 Vienna",
      poBox: "17",
    },
  ],
  birthdays: [{ date: { month: 3, day: 14 } }],
  urls: [
    { value: "https://berger.example", type: "blog", formattedType: "Blog" },
  ],
  biographies: [{ value: "Prefers calls.", contentType: "TEXT_PLAIN" }],
  memberships: [
    {
      contactGroupMembership: {
        contactGroupResourceName: "contactGroups/myContacts",
      },
    },
    {
      contactGroupMembership: {
        contactGroupResourceName: "contactGroups/starred",
      },
    },
    {
      contactGroupMembership: { contactGroupResourceName: "contactGroups/abc" },
    },
    {
      contactGroupMembership: {
        contactGroupResourceName: "contactGroups/friends",
      },
    },
  ],
  photos: [{ url: PHOTO, metadata: { primary: true } }],
  events: [{ date: { month: 6, day: 1 }, type: "anniversary" }],
};

const MAX: PeoplePerson = {
  resourceName: "people/c2",
  etag: "e2",
  names: [{ displayName: "Max Bauer", givenName: "Max", familyName: "Bauer" }],
  emailAddresses: [{ value: "max@bauer.example" }],
  photos: [
    { url: "https://lh3.googleusercontent.com/default=s100", default: true },
  ],
};

const GROUPS = {
  contactGroups: [
    {
      resourceName: "contactGroups/myContacts",
      groupType: "SYSTEM_CONTACT_GROUP",
      name: "myContacts",
    },
    {
      resourceName: "contactGroups/starred",
      groupType: "SYSTEM_CONTACT_GROUP",
      name: "starred",
      formattedName: "Starred",
    },
    {
      resourceName: "contactGroups/friends",
      groupType: "SYSTEM_CONTACT_GROUP",
      name: "friends",
    },
    {
      resourceName: "contactGroups/abc",
      groupType: "USER_CONTACT_GROUP",
      name: "Hiking",
      formattedName: "Hiking",
    },
  ],
};

const OTHER: PeoplePerson = {
  resourceName: "otherContacts/o1",
  names: [{ displayName: "Hannah Zeller" }],
  emailAddresses: [{ value: "hannah@example.com" }],
};

/** Routes for a whole first load. */
function loadRoutes(
  people: PeoplePerson[] = [ANNA, MAX],
): Record<string, Route> {
  return {
    "GET people/me/connections": ({ params }) =>
      params.get("pageToken")
        ? { connections: people.slice(1), nextSyncToken: "sync-c1" }
        : { connections: people.slice(0, 1), nextPageToken: "page-2" },
    "GET contactGroups": () => GROUPS,
    "GET otherContacts": () => ({
      otherContacts: [OTHER],
      nextSyncToken: "sync-o1",
    }),
  };
}

const anna = () => {
  const contact = contactOf(ANNA);
  if (!contact) throw new Error("Anna didn't map");
  return contact;
};

describe("GoogleContactsProvider.load", () => {
  it("reads contacts, labels and Other contacts", async () => {
    const seen = serve(loadRoutes());
    const snapshot = await provider().load(undefined);

    expect(snapshot.addressBooks).toEqual([
      { id: "contacts", name: "Contacts", readOnly: false, isDefault: true },
    ]);
    expect(snapshot.groups).toEqual([
      { id: "contactGroups/starred", name: "Starred" },
      { id: "contactGroups/abc", name: "Hiking" },
    ]);
    expect(snapshot.contacts).toHaveLength(2);
    expect(snapshot.contacts[0]).toEqual({
      id: "people/c1",
      addressBookId: "contacts",
      displayName: "Anna Berger",
      version: "e1",
      photo: {
        kind: "url",
        url: "https://lh3.googleusercontent.com/contacts/anna=s200",
      },
      name: { given: "Anna", middle: "", family: "Berger" },
      nickname: "",
      // The linked profile's address isn't the user's to change.
      emails: [
        { value: "anna@example.org", kind: "work" },
        { value: "anna@uni.example", kind: "other", label: "School" },
      ],
      phones: [
        { value: "+43 664 1234567", kind: "mobile" },
        { value: "+43 1 999", kind: "other", label: "Work fax" },
      ],
      organization: {
        company: "Berger & Partner",
        title: "Lead",
        department: "Ops",
      },
      addresses: [
        {
          street: "Neubaugasse 12",
          city: "Vienna",
          region: "",
          postalCode: "1070",
          country: "Austria",
          kind: "home",
        },
      ],
      birthday: { month: 3, day: 14 },
      websites: [
        { value: "https://berger.example", kind: "other", label: "Blog" },
      ],
      notes: "Prefers calls.",
      groupIds: ["contactGroups/starred", "contactGroups/abc"],
    });
    // Google's placeholder isn't a photo.
    expect(snapshot.contacts[1]?.photo).toBeUndefined();
    expect(snapshot.other).toEqual([
      expect.objectContaining({
        id: "otherContacts/o1",
        displayName: "Hannah Zeller",
        other: true,
      }),
    ]);
    expect(JSON.parse(snapshot.token ?? "")).toEqual({
      contacts: "sync-c1",
      other: "sync-o1",
    });

    const first = seen.find(
      (request) => request.path === "people/me/connections",
    );
    expect(first?.params.get("pageSize")).toBe("1000");
    expect(first?.params.get("requestSyncToken")).toBe("true");
    expect(first?.params.get("personFields")).toContain("memberships");
  });

  it("is read-only without the permission to change contacts", async () => {
    serve(loadRoutes());
    const readOnly = provider([CONTACTS_READ_SCOPE]);
    expect(readOnly.access()).toBe("readOnly");
    const snapshot = await readOnly.load(undefined);
    expect(snapshot.addressBooks[0]?.readOnly).toBe(true);
    // Without their permission there are no Other contacts.
    expect(snapshot.other).toEqual([]);
    await expect(
      readOnly.update(anna(), fieldsOf(anna())),
    ).rejects.toMatchObject({ reason: "contactsAccessNeeded" });

    const none = provider([]);
    expect(none.access()).toBe("missing");
    await expect(none.load(undefined)).rejects.toMatchObject({
      code: "unavailable",
      reason: "contactsAccessNeeded",
    });
  });

  it("applies the changes since the last load, and starts over when the token expired", async () => {
    serve(loadRoutes());
    const contacts = provider();
    const first = await contacts.load(undefined);

    const changedAnna: PeoplePerson = {
      ...ANNA,
      etag: "e1b",
      nicknames: [{ value: "Anni" }],
    };
    const seen = serve({
      "GET people/me/connections": ({ params }) => {
        expect(params.get("syncToken")).toBe("sync-c1");
        return {
          connections: [
            changedAnna,
            { resourceName: "people/c2", metadata: { deleted: true } },
            { resourceName: "people/c3", names: [{ displayName: "Lena" }] },
          ],
          nextSyncToken: "sync-c2",
        };
      },
      "GET contactGroups": () => GROUPS,
      "GET otherContacts": ({ params }) => {
        expect(params.get("syncToken")).toBe("sync-o1");
        return { nextSyncToken: "sync-o2" };
      },
    });
    const second = await contacts.load(first);
    expect(second.contacts.map((contact) => contact.id)).toEqual([
      "people/c1",
      "people/c3",
    ]);
    expect(second.contacts[0]).toMatchObject({
      nickname: "Anni",
      version: "e1b",
    });
    expect(second.other).toEqual(first.other);
    expect(JSON.parse(second.token ?? "")).toEqual({
      contacts: "sync-c2",
      other: "sync-o2",
    });
    expect(
      seen.filter((request) => request.path === "people/me/connections"),
    ).toHaveLength(1);

    let full = 0;
    serve({
      ...loadRoutes([MAX]),
      "GET people/me/connections": ({ params }) => {
        if (params.get("syncToken"))
          return HttpResponse.json(
            {
              error: {
                code: 400,
                status: "FAILED_PRECONDITION",
                message:
                  "Sync token is expired. Clear local cache and retry call without the sync token.",
                details: [{ reason: "EXPIRED_SYNC_TOKEN" }],
              },
            },
            { status: 400 },
          );
        full++;
        return { connections: [MAX], nextSyncToken: "sync-c9" };
      },
    });
    const third = await contacts.load(second);
    expect(full).toBe(1);
    expect(third.contacts.map((contact) => contact.id)).toEqual(["people/c2"]);
  });

  it("says when the People API is switched off", async () => {
    serve({
      ...loadRoutes(),
      "GET people/me/connections": () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message:
                "People API has not been used in project 1 before or it is disabled.",
              status: "PERMISSION_DENIED",
            },
          },
          { status: 403 },
        ),
    });
    await expect(provider().load(undefined)).rejects.toMatchObject({
      reason: "peopleApiDisabled",
    });
  });
});

describe("GoogleContactsProvider.update", () => {
  it("changes only what changed, keeping Google's own parts, and undoes it", async () => {
    let current: PeoplePerson = ANNA;
    const seen = serve({
      "GET people/c1": () => current,
      "PATCH people/c1:updateContact": ({ body }) => {
        current = {
          ...current,
          ...(body as PeoplePerson),
          etag: `${current.etag ?? ""}+`,
        };
        return current;
      },
    });
    const before = anna();
    const fields: ContactFields = {
      ...fieldsOf(before),
      nickname: "Anni",
      phones: [
        { value: "+43 664 7654321", kind: "mobile" },
        { value: "+43 1 999", kind: "other", label: "Work fax" },
      ],
    };
    const write = await provider().update(before, fields);

    const patch = seen.find((request) => request.method === "PATCH");
    expect(patch?.params.get("updatePersonFields")).toBe(
      "nicknames,phoneNumbers",
    );
    const body = patch?.body as PeoplePerson;
    expect(body.etag).toBe("e1");
    expect(body.metadata?.sources).toEqual(ANNA.metadata?.sources);
    expect(body.nicknames).toEqual([{ value: "Anni" }]);
    expect(body.phoneNumbers).toEqual([
      { value: "+43 664 7654321", type: "mobile" },
      // Unchanged: exactly as Google had it.
      { value: "+43 1 999", type: "workFax", formattedType: "Work fax" },
    ]);
    expect(body).not.toHaveProperty("emailAddresses");
    expect(body).not.toHaveProperty("memberships");
    expect(write.contact).toMatchObject({ nickname: "Anni", version: "e1+" });

    const undone = await write.undo();
    const undo = seen.filter((request) => request.method === "PATCH")[1];
    expect(undo?.params.get("updatePersonFields")).toBe(
      "nicknames,phoneNumbers",
    );
    expect((undo?.body as PeoplePerson).etag).toBe("e1+");
    expect(undone).toMatchObject({ nickname: "", phones: before.phones });
  });

  it("keeps My Contacts and groups it doesn't show when labels change", async () => {
    const seen = serve({
      "GET people/c1": () => ANNA,
      "PATCH people/c1:updateContact": () => ANNA,
    });
    await provider().update(anna(), {
      ...fieldsOf(anna()),
      groupIds: [
        asContactGroupId("contactGroups/abc"),
        asContactGroupId("contactGroups/new"),
      ],
    });
    const patch = seen.find((request) => request.method === "PATCH");
    expect(patch?.params.get("updatePersonFields")).toBe("memberships");
    expect((patch?.body as PeoplePerson).memberships).toEqual([
      {
        contactGroupMembership: {
          contactGroupResourceName: "contactGroups/myContacts",
        },
      },
      {
        contactGroupMembership: {
          contactGroupResourceName: "contactGroups/friends",
        },
      },
      {
        contactGroupMembership: {
          contactGroupResourceName: "contactGroups/abc",
        },
      },
      {
        contactGroupMembership: {
          contactGroupResourceName: "contactGroups/new",
        },
      },
    ]);
  });

  it("rewrites a changed address but keeps what else it had", async () => {
    const seen = serve({
      "GET people/c1": () => ANNA,
      "PATCH people/c1:updateContact": () => ANNA,
    });
    const before = anna();
    const [home] = before.addresses;
    if (!home) throw new Error("no address");
    await provider().update(before, {
      ...fieldsOf(before),
      addresses: [{ ...home, street: "Kirchengasse 1" }],
    });
    const body = seen.find((request) => request.method === "PATCH")
      ?.body as PeoplePerson;
    expect(body.addresses).toEqual([
      {
        streetAddress: "Kirchengasse 1",
        city: "Vienna",
        region: "",
        postalCode: "1070",
        country: "Austria",
        type: "home",
        poBox: "17",
      },
    ]);
  });

  it("refuses to overwrite a contact changed elsewhere", async () => {
    let patched = 0;
    serve({
      "GET people/c1": () => ({ ...ANNA, etag: "e9" }),
      "PATCH people/c1:updateContact": () => {
        patched++;
        return ANNA;
      },
    });
    const fields = { ...fieldsOf(anna()), nickname: "Anni" };
    await expect(provider().update(anna(), fields)).rejects.toMatchObject({
      status: 412,
      reason: "contactChanged",
    });
    expect(patched).toBe(0);

    serve({
      "GET people/c1": () => ANNA,
      "PATCH people/c1:updateContact": () =>
        HttpResponse.json(
          {
            error: {
              code: 400,
              status: "FAILED_PRECONDITION",
              message:
                "Request person.etag is different than the current person.etag.",
            },
          },
          { status: 400 },
        ),
    });
    await expect(provider().update(anna(), fields)).rejects.toMatchObject({
      reason: "contactChanged",
    });

    serve({
      "GET people/c1": () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not found" } },
          { status: 404 },
        ),
    });
    await expect(provider().update(anna(), fields)).rejects.toMatchObject({
      code: "not-found",
      reason: "contactGone",
    });
  });
});

describe("GoogleContactsProvider.create", () => {
  const NEW: ContactFields = {
    ...EMPTY_FIELDS,
    name: { given: "Lena", middle: "", family: "Huber" },
    emails: [{ value: "lena@example.org", kind: "work" }],
    birthday: { month: 5, day: 4, year: 1990 },
    groupIds: [asContactGroupId("contactGroups/abc")],
  };

  it("creates a contact with its photo, and undo deletes it", async () => {
    const created: PeoplePerson = {
      resourceName: "people/c7",
      etag: "n1",
      names: [
        { displayName: "Lena Huber", givenName: "Lena", familyName: "Huber" },
      ],
    };
    const seen = serve({
      "POST people:createContact": () => created,
      "PATCH people/c7:updateContactPhoto": () => ({
        person: {
          ...created,
          photos: [{ url: "https://lh3.googleusercontent.com/lena=s100" }],
        },
      }),
      "DELETE people/c7:deleteContact": () => undefined,
    });
    const photo = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    const write = await provider().create(asAddressBook(), {
      fields: NEW,
      photo,
    });

    const post = seen.find(
      (request) => request.path === "people:createContact",
    );
    expect(post?.params.get("personFields")).toContain("names");
    expect(post?.body).toEqual({
      names: [{ givenName: "Lena", familyName: "Huber" }],
      emailAddresses: [{ value: "lena@example.org", type: "work" }],
      birthdays: [{ date: { year: 1990, month: 5, day: 4 } }],
      memberships: [
        {
          contactGroupMembership: {
            contactGroupResourceName: "contactGroups/myContacts",
          },
        },
        {
          contactGroupMembership: {
            contactGroupResourceName: "contactGroups/abc",
          },
        },
      ],
    });
    const upload = seen.find((request) =>
      request.path.endsWith(":updateContactPhoto"),
    );
    expect(upload?.body).toMatchObject({ photoBytes: "BwgJ" });
    expect(write.contact).toMatchObject({
      id: "people/c7",
      displayName: "Lena Huber",
      photo: {
        kind: "url",
        url: "https://lh3.googleusercontent.com/lena=s200",
      },
    });

    expect(await write.undo()).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "people/c7:deleteContact",
    });
  });

  it("imports in batches of 200, reporting progress and failures one by one", async () => {
    const batches: number[] = [];
    let next = 0;
    serve({
      "POST people:batchCreateContacts": ({ body }) => {
        const { contacts } = body as { contacts: unknown[] };
        batches.push(contacts.length);
        return {
          createdPeople: contacts.map((_, index) =>
            batches.length === 2 && index === 3
              ? {
                  httpStatusCode: 400,
                  status: { code: 3, message: "Invalid email" },
                }
              : {
                  httpStatusCode: 200,
                  person: {
                    resourceName: `people/n${String(next++)}`,
                    names: [{ displayName: "X" }],
                  },
                },
          ),
        };
      },
    });
    const progress: number[] = [];
    const results = await provider().createMany(
      asAddressBook(),
      Array.from({ length: 250 }, () => ({ fields: NEW })),
      { onProgress: (done) => progress.push(done) },
    );
    expect(batches).toEqual([200, 50]);
    expect(progress).toEqual([200, 250]);
    expect(results).toHaveLength(250);
    const failed = results[203];
    expect(failed).toBeInstanceOf(MailError);
    expect((failed as MailError).message).toContain("Invalid email");
    expect(
      results.filter((result) => result instanceof MailError),
    ).toHaveLength(1);
  });
});

describe("GoogleContactsProvider.remove", () => {
  it("deletes contacts and brings them back with everything they had", async () => {
    let next = 0;
    const seen = serve({
      "GET people:batchGet": ({ params }) => {
        expect(params.getAll("resourceNames")).toEqual([
          "people/c1",
          "people/c2",
        ]);
        return { responses: [{ person: ANNA }, { person: MAX }] };
      },
      "POST people:batchDeleteContacts": () => undefined,
      "POST people:batchCreateContacts": ({ body }) => ({
        createdPeople: (
          body as { contacts: { contactPerson: PeoplePerson }[] }
        ).contacts.map(({ contactPerson }) => ({
          person: {
            ...contactPerson,
            resourceName: `people/r${String(next++)}`,
          },
        })),
      }),
      "PATCH people/r0:updateContactPhoto": () => ({
        person: { resourceName: "people/r0" },
      }),
    });
    const max = contactOf(MAX);
    if (!max) throw new Error("Max didn't map");
    const removal = await provider().remove([anna(), max]);

    expect(
      seen.find((request) => request.path === "people:batchDeleteContacts")
        ?.body,
    ).toEqual({
      resourceNames: ["people/c1", "people/c2"],
    });

    const restored = await removal.undo();
    expect(restored.map((contact) => contact.id)).toEqual([
      "people/r0",
      "people/r1",
    ]);
    const create = seen.find(
      (request) => request.path === "people:batchCreateContacts",
    );
    const [annaAgain] = (
      create?.body as { contacts: { contactPerson: PeoplePerson }[] }
    ).contacts;
    // As Google had her, without what Google works out itself.
    expect(annaAgain?.contactPerson).toEqual({
      names: [{ givenName: "Anna", familyName: "Berger" }],
      emailAddresses: [
        { value: "anna@example.org", type: "work" },
        { value: "anna@uni.example", type: "school" },
      ],
      phoneNumbers: [
        { value: "+43 664 1234567", type: "mobile" },
        { value: "+43 1 999", type: "workFax" },
      ],
      organizations: ANNA.organizations,
      addresses: [
        {
          streetAddress: "Neubaugasse 12",
          city: "Vienna",
          postalCode: "1070",
          country: "Austria",
          type: "home",
          formattedValue: "Neubaugasse 12\n1070 Vienna",
          poBox: "17",
        },
      ],
      birthdays: ANNA.birthdays,
      urls: [{ value: "https://berger.example", type: "blog" }],
      biographies: ANNA.biographies,
      memberships: ANNA.memberships,
      events: ANNA.events,
    });
    // Anna's photo goes back too.
    expect(
      seen.find((request) => request.path === "people/r0:updateContactPhoto")
        ?.body,
    ).toMatchObject({ photoBytes: "AQID" });
  });

  it("deletes one contact on its own", async () => {
    const seen = serve({
      "GET people:batchGet": () => ({ responses: [{ person: MAX }] }),
      "DELETE people/c2:deleteContact": () => undefined,
    });
    const max = contactOf(MAX);
    if (!max) throw new Error("Max didn't map");
    await provider().remove([max]);
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "people/c2:deleteContact",
    });
  });
});

describe("GoogleContactsProvider groups, Other contacts and access", () => {
  it("creates labels and adds Other contacts to the contacts", async () => {
    const seen = serve({
      "POST contactGroups": () => ({
        resourceName: "contactGroups/fam",
        name: "Family",
        formattedName: "Family",
      }),
      "POST otherContacts/o1:copyOtherContactToMyContactsGroup": () => ({
        resourceName: "people/c8",
        names: [{ displayName: "Hannah Zeller" }],
      }),
      "DELETE people/c8:deleteContact": () => undefined,
    });
    const contacts = provider();
    expect(await contacts.createGroup(" Family ")).toEqual({
      id: "contactGroups/fam",
      name: "Family",
    });
    expect(seen[0]?.body).toEqual({ contactGroup: { name: "Family" } });

    const other = contactOf(OTHER, true);
    if (!other) throw new Error("Hannah didn't map");
    const write = await contacts.addOther(other);
    expect(write.contact).toMatchObject({
      id: "people/c8",
      displayName: "Hannah Zeller",
    });
    expect(write.contact.other).toBeUndefined();
    expect(seen[1]?.body).toMatchObject({
      copyMask: "names,emailAddresses,phoneNumbers",
    });
    await write.undo();
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "people/c8:deleteContact",
    });
  });

  it("asks for the permission to change contacts", async () => {
    const http = new GmailHttp({
      auth: new StaticAuthSession(),
      baseUrl: PEOPLE_API_BASE,
    });
    const { session, asked } = scoped(
      [CONTACTS_READ_SCOPE],
      [CONTACTS_WRITE_SCOPE],
    );
    const contacts = new GoogleContactsProvider(http, session);
    // Granting editing but not the Other contacts is enough.
    await contacts.requestAccess();
    expect(asked).toEqual([[CONTACTS_WRITE_SCOPE, OTHER_CONTACTS_SCOPE]]);
    expect(contacts.access()).toBe("granted");

    const declined = new GoogleContactsProvider(
      http,
      scoped([CONTACTS_READ_SCOPE]).session,
    );
    await expect(declined.requestAccess()).rejects.toMatchObject({
      reason: "accessNotGranted",
    });
  });

  it("loads a photo, and nothing for contacts without one", async () => {
    serve({});
    const blob = await provider().photo(anna());
    expect(blob?.size).toBe(3);
    const max = contactOf(MAX);
    if (!max) throw new Error("Max didn't map");
    expect(await provider().photo(max)).toBeUndefined();
  });
});

function asAddressBook() {
  return "contacts" as Contact["addressBookId"];
}
