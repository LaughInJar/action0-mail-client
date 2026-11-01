import { describe, expect, it } from "vitest";
import {
  asAddressBookId,
  asContactGroupId,
  asContactId,
  displayNameOf,
  EMPTY_FIELDS,
  findDuplicates,
  fitTo,
  initialsOf,
  letterOf,
  matchesSearch,
  mergeFields,
  normalized,
  phoneKey,
  sameFields,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
} from "./contacts";

const contact = (
  id: string,
  fields: Partial<ContactFields>,
  extra: Partial<Contact> = {},
): Contact => {
  const all = { ...EMPTY_FIELDS, ...fields };
  return {
    ...all,
    id: asContactId(id),
    addressBookId: asAddressBookId("book"),
    displayName: displayNameOf(all),
    ...extra,
  };
};
const named = (given: string, family: string) => ({
  name: { given, middle: "", family },
});

const OUTLOOK: ContactCapabilities = {
  emailKinds: false,
  maxEmails: 3,
  phoneKinds: ["mobile", "home", "work"],
  maxPhones: { mobile: 1, home: 2, work: 2 },
  addressKinds: ["home", "work", "other"],
  oneAddressPerKind: true,
  websiteKinds: false,
  maxWebsites: 1,
  birthdayYear: true,
  groups: true,
  otherContacts: false,
};

describe("names", () => {
  it("shows the full name, else a nickname, company or address", () => {
    expect(displayNameOf({ ...EMPTY_FIELDS, ...named("Anna", "Berger") })).toBe(
      "Anna Berger",
    );
    expect(
      displayNameOf({
        ...EMPTY_FIELDS,
        organization: { company: "Bella", title: "", department: "" },
      }),
    ).toBe("Bella");
    expect(
      displayNameOf({
        ...EMPTY_FIELDS,
        emails: [{ value: "x@example.com", kind: "home" }],
      }),
    ).toBe("x@example.com");
    expect(initialsOf("Anna Maria Berger")).toBe("AB");
    expect(initialsOf("anna@example.com")).toBe("A");
    expect(letterOf("Öztürk")).toBe("O");
    expect(letterOf("+43 1 555")).toBe("#");
  });
});

describe("matchesSearch", () => {
  const anna = contact("a", {
    ...named("Anna", "Berger"),
    emails: [{ value: "anna.b@mail.example", kind: "home" }],
    phones: [{ value: "+43 664 123 4567", kind: "mobile" }],
    organization: { company: "Berger & Partner", title: "", department: "" },
  });

  it("matches the start of words of the name, company and addresses", () => {
    expect(matchesSearch(anna, "ann ber")).toBe(true);
    expect(matchesSearch(anna, "partner")).toBe(true);
    expect(matchesSearch(anna, "mail.ex")).toBe(true);
    expect(matchesSearch(anna, "nna")).toBe(false);
  });

  it("matches digits anywhere in a phone number, and ignores accents", () => {
    expect(matchesSearch(anna, "1234")).toBe(true);
    const jurgen = contact("j", named("Jürgen", "Öztürk"));
    expect(matchesSearch(jurgen, "jurg oz")).toBe(true);
  });
});

describe("findDuplicates", () => {
  it("groups by address, phone number and full name, most complete first", () => {
    const sets = findDuplicates([
      contact("a1", {
        ...named("Anna", "Berger"),
        emails: [{ value: "Anna@Example.org", kind: "home" }],
      }),
      contact("a2", {
        ...named("Anna", "B."),
        emails: [
          { value: "anna@example.org", kind: "work" },
          { value: "a@b.example", kind: "home" },
        ],
      }),
      contact("l1", { phones: [{ value: "0676 555 0101", kind: "mobile" }] }),
      contact("l2", { phones: [{ value: "+43 676 5550101", kind: "home" }] }),
      contact("m1", named("Mia", "Steiner")),
      contact("m2", named("mia", "steiner")),
      contact("x", named("Mia", "")),
      contact("o", named("Mia", "Steiner"), { other: true }),
    ]);
    expect(
      sets.map((set) => [set.reason, set.contacts.map((member) => member.id)]),
    ).toEqual([
      ["email", ["a2", "a1"]],
      ["phone", ["l1", "l2"]],
      ["name", ["m1", "m2"]],
    ]);
  });

  it("joins sets transitively and names the strongest reason", () => {
    const sets = findDuplicates([
      contact("1", {
        ...named("Tom", "Brandt"),
        phones: [{ value: "+43 664 300 4000", kind: "mobile" }],
      }),
      contact("2", named("Tom", "Brandt")),
      contact("3", {
        emails: [{ value: "tom@x.example", kind: "work" }],
        phones: [{ value: "0664 3004000", kind: "work" }],
      }),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.reason).toBe("phone");
    expect(sets[0]?.contacts).toHaveLength(3);
  });
});

describe("mergeFields", () => {
  it("keeps what the first has and adds what it doesn't, without duplicates", () => {
    const merged = mergeFields(
      {
        ...EMPTY_FIELDS,
        ...named("Lukas", "Hofer"),
        emails: [{ value: "lukas@example.net", kind: "home" }],
        phones: [{ value: "0676 555 0101", kind: "mobile" }],
        notes: "Hiking",
        groupIds: [asContactGroupId("hiking")],
      },
      [
        {
          ...EMPTY_FIELDS,
          ...named("Luke", "H."),
          emails: [
            { value: "LUKAS@example.net", kind: "work" },
            { value: "lukas.hofer@work.example", kind: "work" },
          ],
          phones: [{ value: "+43 676 5550101", kind: "work" }],
          organization: { company: "Hofer Bau", title: "", department: "" },
          birthday: { month: 5, day: 1 },
          notes: "Builder",
          groupIds: [asContactGroupId("hiking"), asContactGroupId("work")],
        },
      ],
    );
    expect(merged.name).toEqual(named("Lukas", "Hofer").name);
    expect(merged.emails.map((email) => email.value)).toEqual([
      "lukas@example.net",
      "lukas.hofer@work.example",
    ]);
    expect(merged.phones).toHaveLength(1);
    expect(merged.organization.company).toBe("Hofer Bau");
    expect(merged.birthday).toEqual({ month: 5, day: 1 });
    expect(merged.notes).toBe("Hiking\n\nBuilder");
    expect(merged.groupIds).toEqual(["hiking", "work"]);
  });
});

describe("fitTo", () => {
  it("fits fields into what Outlook can hold, saying when something is left out", () => {
    const { fields, dropped } = fitTo(OUTLOOK, {
      ...EMPTY_FIELDS,
      emails: ["a", "b", "c", "d"].map((value) => ({
        value: `${value}@x.example`,
        kind: "home" as const,
      })),
      phones: [
        { value: "1", kind: "mobile" },
        { value: "2", kind: "mobile" },
        { value: "3", kind: "other" },
      ],
      addresses: [
        { ...ADDRESS, kind: "home" },
        { ...ADDRESS, city: "Graz", kind: "home" },
      ],
      birthday: { month: 1, day: 2 },
    });
    expect(dropped).toBe(true);
    expect(fields.emails).toHaveLength(3);
    expect(fields.emails[0]?.kind).toBe("other");
    expect(fields.phones.map((phone) => phone.kind)).toEqual([
      "mobile",
      "home",
      "home",
    ]);
    expect(fields.addresses.map((address) => address.kind)).toEqual([
      "home",
      "other",
    ]);
    expect(fields.birthday).toBeUndefined();
  });

  it("keeps everything that fits", () => {
    const fields = {
      ...EMPTY_FIELDS,
      emails: [{ value: "a@x.example", kind: "other" as const }],
    };
    expect(fitTo(OUTLOOK, fields)).toEqual({ fields, dropped: false });
  });
});

const ADDRESS = {
  street: "Hauptplatz 3",
  postalCode: "8010",
  city: "Graz",
  region: "",
  country: "Austria",
};

describe("normalized and sameFields", () => {
  it("ignore blank values and surrounding spaces", () => {
    const a = {
      ...EMPTY_FIELDS,
      ...named(" Anna ", "Berger"),
      emails: [
        { value: "anna@example.org ", kind: "home" as const },
        { value: "  ", kind: "work" as const },
      ],
    };
    expect(normalized(a).emails).toEqual([
      { value: "anna@example.org", kind: "home" },
    ]);
    expect(
      sameFields(a, {
        ...EMPTY_FIELDS,
        ...named("Anna", "Berger"),
        emails: [{ value: "anna@example.org", kind: "home" }],
      }),
    ).toBe(true);
  });

  it("compare phone numbers by their last nine digits", () => {
    expect(phoneKey("+43 664 123 4567")).toBe(phoneKey("0664/1234567"));
    expect(phoneKey("12 34")).toBeUndefined();
  });
});
