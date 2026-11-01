import { describe, expect, it } from "vitest";
import {
  asContactGroupId,
  EMPTY_FIELDS,
  type ContactFields,
} from "../../core/contacts";
import { loadIcal } from "../ical/icalendar";
import {
  createContactCards,
  editCard,
  fieldsOfCard,
  fromVcard21,
  newCard,
  readCard,
  splitCards,
  storableCard,
} from "./vcard";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

/** A 3.0 card the way Apple and Nextcloud write them. */
const apple = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
  "N:Berger;Anna;Maria;Dr.;",
  "FN:Anna Berger",
  "NICKNAME:Anni",
  "ORG:Berger & Partner;Projects;Vienna office",
  "TITLE:Project lead",
  "item1.EMAIL;type=INTERNET;type=pref:anna@example.org",
  "item1.X-ABLabel:_$!<Other>!$_",
  "EMAIL;type=INTERNET;type=WORK:anna.berger@work.example",
  "TEL;type=CELL;type=VOICE;type=pref:+43 664 123 4567",
  "item2.TEL:+43 1 999",
  "item2.X-ABLabel:Assistant",
  "TEL;type=WORK;type=FAX:+43 1 234 5679",
  "item3.ADR;type=HOME:;;Neubaugasse 12;Vienna;;1070;Austria",
  "item3.X-ABADR:at",
  "BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-14",
  "URL;type=WORK:https://berger.example",
  "NOTE:Prefers calls in the morning\\, before 10.\\nNever on Fridays.",
  "CATEGORIES:Work,Starred",
  "X-SOCIALPROFILE;type=twitter:https://x.example/anna",
  "IMPP;X-SERVICE-TYPE=Skype:skype:anna.b",
  "UID:anna-1",
  "REV:2026-01-01T00:00:00Z",
  "END:VCARD",
  "",
].join("\r\n");

const v4 = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Max Huber",
  "N:Huber;Max;;;",
  "EMAIL;TYPE=home;PREF=1:max@example.at",
  "TEL;VALUE=uri;TYPE=cell:tel:+43-650-1234",
  "BDAY:--0702",
  "PHOTO:data:image/png;base64,iVBORw0KGgo=",
  "ANNIVERSARY:20100601",
  "END:VCARD",
  "",
].join("\r\n");

describe("reading vCards", () => {
  it("reads a 3.0 card with Apple's labels, groups and types", async () => {
    const ICAL = await loadIcal();
    const card = readCard(ICAL, apple);
    expect(card).toMatchObject({
      displayName: "Anna Berger",
      version: "3.0",
      uid: "anna-1",
      isGroup: false,
      more: true,
    });
    expect(card?.fields).toEqual<ContactFields>({
      name: { given: "Anna", middle: "Maria", family: "Berger" },
      nickname: "Anni",
      emails: [
        { value: "anna@example.org", kind: "other" },
        { value: "anna.berger@work.example", kind: "work" },
      ],
      phones: [
        { value: "+43 664 123 4567", kind: "mobile" },
        { value: "+43 1 999", kind: "other", label: "Assistant" },
        { value: "+43 1 234 5679", kind: "work", label: "Fax" },
      ],
      organization: {
        company: "Berger & Partner",
        title: "Project lead",
        department: "Projects",
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
      websites: [{ value: "https://berger.example", kind: "work" }],
      notes: "Prefers calls in the morning, before 10.\nNever on Fridays.",
      groupIds: [asContactGroupId("Work"), asContactGroupId("Starred")],
    });
  });

  it("reads 4.0 cards: yearless birthdays, tel: URIs, embedded photos", async () => {
    const ICAL = await loadIcal();
    const card = readCard(ICAL, v4);
    expect(card?.fields.birthday).toEqual({ month: 7, day: 2 });
    expect(card?.fields.phones).toEqual([
      { value: "+43-650-1234", kind: "mobile" },
    ]);
    expect(card?.fields.emails).toEqual([
      { value: "max@example.at", kind: "home" },
    ]);
    expect(card?.photo).toEqual({
      mediaType: "image/png",
      base64: "iVBORw0KGgo=",
    });
    expect(card?.more).toBe(true);
  });

  it("leaves pictures elsewhere alone and recognises group cards", async () => {
    const ICAL = await loadIcal();
    const linked = readCard(
      ICAL,
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nN:;X;;;\r\nPHOTO;VALUE=URI:https://tracker.example/x.jpg\r\nEND:VCARD\r\n",
    );
    expect(linked?.photo).toBeUndefined();
    expect(
      readCard(
        ICAL,
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Friends\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nEND:VCARD\r\n",
      )?.isGroup,
    ).toBe(true);
    expect(
      readCard(ICAL, "BEGIN:VCARD\r\nVERSION:4.0\r\nKIND:group\r\nEND:VCARD")
        ?.isGroup,
    ).toBe(true);
  });

  it("reads vCard 2.1: bare types, quoted-printable, character sets, base64", async () => {
    const ICAL = await loadIcal();
    const old = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:=D6zt=FCrk;J=FCrgen;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen =C3=96zt=C3=BCrk",
      "TEL;CELL;VOICE:+43 316 12 34 56",
      "TEL;HOME:0316 1234",
      "EMAIL;INTERNET;WORK:j@example.at",
      "NOTE;ENCODING=QUOTED-PRINTABLE:First line, with a comma=0D=0A=",
      "second line",
      "ADR;HOME:;;Hauptplatz 3, Top 4;Graz;;8010;Austria",
      "PHOTO;JPEG;ENCODING=BASE64:",
      " /9j/4AAQ",
      " SkZJRg==",
      "",
      "END:VCARD",
    ].join("\r\n");
    const converted = fromVcard21(old);
    expect(converted).toContain("VERSION:3.0");
    expect(converted).toContain("TEL;TYPE=CELL,VOICE:+43 316 12 34 56");
    const card = readCard(ICAL, old);
    expect(card?.version).toBe("3.0");
    expect(card?.displayName).toBe("Jürgen Öztürk");
    expect(card?.fields.name).toEqual({
      given: "Jürgen",
      middle: "",
      family: "Öztürk",
    });
    expect(card?.fields.phones).toEqual([
      { value: "+43 316 12 34 56", kind: "mobile" },
      { value: "0316 1234", kind: "home" },
    ]);
    expect(card?.fields.emails).toEqual([
      { value: "j@example.at", kind: "work" },
    ]);
    expect(card?.fields.notes).toBe("First line, with a comma\nsecond line");
    expect(card?.fields.addresses[0]?.street).toBe("Hauptplatz 3, Top 4");
    expect(card?.photo).toEqual({
      mediaType: "image/jpeg",
      base64: "/9j/4AAQSkZJRg==",
    });
  });

  it("splits a file into its cards", () => {
    expect(splitCards(`${apple}\n${v4}garbage`)).toEqual([apple, v4]);
  });
});

describe("changing a card in place", () => {
  it("returns it untouched when nothing changed", async () => {
    const ICAL = await loadIcal();
    const fields = fieldsOfCard(ICAL, apple);
    expect(fields && editCard(ICAL, apple, fields, { now: NOW })).toBe(apple);
  });

  it("sets, replaces and removes the embedded photo, and leaves it when it's the same", async () => {
    const ICAL = await loadIcal();
    const fields = fieldsOfCard(ICAL, v4);
    if (!fields) throw new Error("no fields");
    const jpeg = { mediaType: "image/jpeg", base64: "QUJD" };
    const replaced = editCard(ICAL, v4, fields, { now: NOW, photo: jpeg });
    expect(replaced).toContain("PHOTO:data:image/jpeg;base64,QUJD\r\n");
    expect(replaced).not.toContain("image/png");
    expect(replaced).toContain("ANNIVERSARY:20100601\r\n");
    const removed = editCard(ICAL, v4, fields, { now: NOW, photo: null });
    expect(removed).not.toContain("PHOTO");
    const same = { mediaType: "image/png", base64: "iVBORw0KGgo=" };
    expect(editCard(ICAL, v4, fields, { now: NOW, photo: same })).toBe(v4);
  });

  it("rewrites only what changed and keeps everything else byte for byte", async () => {
    const ICAL = await loadIcal();
    const fields = fieldsOfCard(ICAL, apple);
    if (!fields) throw new Error("unread");
    const edited = editCard(
      ICAL,
      apple,
      {
        ...fields,
        // The mobile number changes; the others stay.
        phones: [
          { value: "+43 664 000 0000", kind: "mobile" },
          ...fields.phones.slice(1),
        ],
      },
      { now: NOW },
    );
    const before = apple.split("\r\n");
    const after = edited.split("\r\n");
    expect(after[1]).toBe("VERSION:3.0");
    expect(after).toContain("TEL;TYPE=CELL:+43 664 000 0000");
    expect(after).not.toContain(
      "TEL;type=CELL;type=VOICE;type=pref:+43 664 123 4567",
    );
    // Every other line is still there, as it was.
    for (const line of before)
      if (!line.includes("+43 664 123 4567") && !line.startsWith("REV:"))
        expect(after).toContain(line);
    expect(after).toContain("REV:20261031T120000Z");
    expect(readCard(ICAL, edited)?.fields.phones[0]).toEqual({
      value: "+43 664 000 0000",
      kind: "mobile",
    });
  });

  it("drops Apple's labels with their values and labels new ones", async () => {
    const ICAL = await loadIcal();
    const fields = fieldsOfCard(ICAL, apple);
    if (!fields) throw new Error("unread");
    const edited = editCard(
      ICAL,
      apple,
      {
        ...fields,
        emails: fields.emails.slice(1),
        phones: [
          ...fields.phones,
          { value: "+43 1 555", kind: "other", label: "Doorman" },
        ],
      },
      { now: NOW },
    );
    expect(edited).not.toContain("anna@example.org");
    expect(edited).not.toContain("_$!<Other>!$_");
    expect(edited).toContain("item2.X-ABLabel:Assistant");
    expect(edited).toContain("item4.TEL:+43 1 555\r\nitem4.X-ABLabel:Doorman");
    expect(readCard(ICAL, edited)?.fields.phones.at(-1)).toEqual({
      value: "+43 1 555",
      kind: "other",
      label: "Doorman",
    });
  });

  it("keeps the name's prefix and a chosen FN, and follows a renamed person", async () => {
    const ICAL = await loadIcal();
    const fields = fieldsOfCard(ICAL, apple);
    if (!fields) throw new Error("unread");
    const renamed = editCard(
      ICAL,
      apple,
      { ...fields, name: { ...fields.name, family: "Berger-Huber" } },
      { now: NOW },
    );
    expect(renamed).toContain("N:Berger-Huber;Anna;Maria;Dr.;\r\n");
    expect(renamed).toContain("FN:Anna Maria Berger-Huber\r\n");

    const custom = apple.replace("FN:Anna Berger", "FN:Anni (school)");
    const noted = editCard(
      ICAL,
      custom,
      { ...fields, notes: "New note; with a semicolon" },
      { now: NOW },
    );
    expect(noted).toContain("FN:Anni (school)");
    expect(noted).toContain("NOTE:New note\\; with a semicolon\r\n");
  });

  it("writes yearless birthdays the way each version can", async () => {
    const ICAL = await loadIcal();
    const three = fieldsOfCard(ICAL, apple);
    const four = fieldsOfCard(ICAL, v4);
    if (!three || !four) throw new Error("unread");
    const a = editCard(
      ICAL,
      apple,
      { ...three, birthday: { month: 12, day: 24 } },
      { now: NOW },
    );
    expect(a).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-12-24\r\n");
    expect(readCard(ICAL, a)?.fields.birthday).toEqual({ month: 12, day: 24 });
    const b = editCard(
      ICAL,
      v4,
      { ...four, birthday: { month: 12, day: 24 } },
      { now: NOW },
    );
    expect(b).toContain("BDAY:--1224\r\n");
    const c = editCard(
      ICAL,
      v4,
      { ...four, birthday: { year: 1990, month: 1, day: 5 } },
      { now: NOW },
    );
    expect(c).toContain("BDAY:19900105\r\n");
    expect(readCard(ICAL, c)?.fields.birthday).toEqual({
      year: 1990,
      month: 1,
      day: 5,
    });
    const d = editCard(ICAL, v4, { ...four, birthday: undefined } as never, {
      now: NOW,
    });
    expect(d).not.toContain("BDAY");
  });

  it("adds a UID to a card without one (imports) and converts 2.1", async () => {
    const ICAL = await loadIcal();
    const stored = storableCard(
      ICAL,
      "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane\r\nTEL;CELL:123\r\nEND:VCARD\r\n",
      { uid: "u-1", now: NOW },
    );
    expect(stored).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(stored).toContain("UID:u-1\r\n");
    expect(stored).toContain("FN:Jane Doe\r\n");
    expect(readCard(ICAL, stored)?.uid).toBe("u-1");
    // A card that has a UID is stored as it is.
    expect(storableCard(ICAL, apple, { uid: "other", now: NOW })).toBe(apple);
  });
});

describe("new cards", () => {
  it("writes every field as vCard 3.0 and reads back the same", async () => {
    const ICAL = await loadIcal();
    const fields: ContactFields = {
      ...EMPTY_FIELDS,
      name: { given: "Lena", middle: "", family: "Huber" },
      nickname: "Leni",
      emails: [
        { value: "lena@example.org", kind: "home" },
        { value: "lena@library.example", kind: "work" },
      ],
      phones: [
        { value: "+43 660 222 3333", kind: "mobile" },
        { value: "+43 1 555", kind: "work", label: "Fax" },
        { value: "+43 1 556", kind: "other", label: "Front desk" },
      ],
      organization: {
        company: "City Library; Main",
        title: "Librarian",
        department: "Loans",
      },
      addresses: [
        {
          street: "Ring 1\nTop 2",
          city: "Linz",
          region: "",
          postalCode: "4020",
          country: "Austria",
          kind: "work",
        },
      ],
      birthday: { year: 1985, month: 6, day: 30 },
      websites: [{ value: "https://library.example/a,b", kind: "work" }],
      notes: "Long note ".repeat(20).trim(),
      groupIds: [asContactGroupId("Work"), asContactGroupId("Books, old")],
    };
    const card = newCard(fields, {
      uid: "new-1",
      now: NOW,
      photo: { mediaType: "image/jpeg", base64: "QUJD" },
    });
    expect(card).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(card).toContain("PHOTO;ENCODING=b;TYPE=JPEG:QUJD\r\n");
    // Long lines are folded at 75 octets.
    for (const line of card.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const read = readCard(ICAL, card);
    expect(read?.fields).toEqual(fields);
    expect(read?.displayName).toBe("Lena Huber");
    expect(read?.uid).toBe("new-1");
  });
});

describe("vCard files", () => {
  it("imports every person of a file, with their categories and photos", async () => {
    const cards = createContactCards({ now: () => NOW });
    const parsed = await cards.parse(
      [
        apple,
        v4,
        "BEGIN:VCARD\r\nVERSION:4.0\r\nKIND:group\r\nFN:Team\r\nEND:VCARD\r\n",
        "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane\r\nEND:VCARD\r\n",
      ].join(""),
    );
    expect(parsed.map((card) => card.displayName)).toEqual([
      "Anna Berger",
      "Max Huber",
      "Jane Doe",
    ]);
    expect(parsed[0]?.groups).toEqual(["Work", "Starred"]);
    expect(parsed[0]?.fields.groupIds).toEqual([]);
    expect(parsed[0]?.card).toBe(apple);
    expect(parsed[1]?.photo?.type).toBe("image/png");
    expect(parsed[2]?.card).toContain("VERSION:3.0");
    expect(parsed[2]?.more).toBe(false);
    expect(await cards.parse("nothing here")).toEqual([]);
  });

  it("exports cards as stored, and others as 3.0 with photos", async () => {
    const cards = createContactCards({ now: () => NOW });
    const text = await cards.format([
      { fields: EMPTY_FIELDS, displayName: "", groups: [], raw: v4 },
      {
        fields: {
          ...EMPTY_FIELDS,
          name: { given: "Paul", middle: "", family: "Novak" },
          emails: [{ value: "paul@example.cz", kind: "home" }],
        },
        displayName: "Paul Novak",
        groups: ["Friends"],
        photo: new Blob([new Uint8Array([65, 66, 67])], {
          type: "image/jpeg",
        }),
      },
    ]);
    const [first, second] = splitCards(text);
    expect(first).toBe(v4);
    expect(second).toContain("FN:Paul Novak\r\n");
    expect(second).toContain("CATEGORIES:Friends\r\n");
    expect(second).toContain("PHOTO;ENCODING=b;TYPE=JPEG:QUJD\r\n");
    const back = await cards.parse(text);
    expect(back[1]?.fields.emails).toEqual([
      { value: "paul@example.cz", kind: "home" },
    ]);
  });
});
