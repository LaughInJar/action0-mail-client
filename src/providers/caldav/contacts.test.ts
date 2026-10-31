import { describe, expect, it } from "vitest";
import { DAV_CONTACTS, fakeDavServer } from "../../test/davServer";
import { loadIcal } from "../ical/icalendar";
import {
  CardDavAddressBooks,
  mergeMatches,
  readContacts,
  scoreOf,
} from "./contacts";
import { createCalendarServers } from "./servers";

const KEY = "imap:me@example.com";

const anna = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Anna Berger",
  "N:Berger;Anna;;;",
  "NICKNAME:Anni",
  "ORG:Example Corp;Sales",
  "item1.EMAIL;type=INTERNET;type=pref:anna@example.org",
  "EMAIL;TYPE=WORK:anna.berger@work.example",
  "END:VCARD",
].join("\r\n");

const max = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "N:Huber;Max;;;",
  "EMAIL;PREF=1:max@example.at",
  "END:VCARD",
].join("\r\n");

const jurgen = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Jürgen Österreicher",
  "EMAIL:j.oe@example.at",
  "TEL:+43 1 234",
  "END:VCARD",
].join("\r\n");

describe("reading vCards", () => {
  it("takes every address of a contact, from 3.0 and 4.0 cards", async () => {
    const ICAL = await loadIcal();
    expect(
      readContacts(ICAL, `${anna}\r\n${max}`).map((entry) => [
        entry.address,
        entry.preferred,
      ]),
    ).toEqual([
      [{ name: "Anna Berger", address: "anna@example.org" }, true],
      [{ name: "Anna Berger", address: "anna.berger@work.example" }, false],
      // No FN: the name from N.
      [{ name: "Max Huber", address: "max@example.at" }, true],
    ]);
    expect(readContacts(ICAL, "not a vcard")).toEqual([]);
    expect(
      readContacts(
        ICAL,
        "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:No mail\r\nEND:VCARD",
      ),
    ).toEqual([]);
  });

  it("matches the starts of words in names, nicknames, companies and addresses", async () => {
    const ICAL = await loadIcal();
    const [preferred, work] = readContacts(ICAL, anna);
    const [oe] = readContacts(ICAL, jurgen);
    expect(scoreOf(preferred!, "anna")).toBeGreaterThan(scoreOf(work!, "anna"));
    expect(scoreOf(preferred!, "ber")).toBeGreaterThan(0);
    expect(scoreOf(preferred!, "anni")).toBeGreaterThan(0);
    expect(scoreOf(preferred!, "sales")).toBeGreaterThan(0);
    expect(scoreOf(preferred!, "nna")).toBe(0);
    // Accents don't matter.
    expect(scoreOf(oe!, "jurg oster")).toBeGreaterThan(0);
    // An address-only match ranks below a name match.
    expect(scoreOf(oe!, "j")).toBeGreaterThan(scoreOf(oe!, "example"));
  });

  it("merges address books, keeping each address once at its best", () => {
    expect(
      mergeMatches([
        [
          { address: { address: "a@x" }, score: 1 },
          { address: { address: "b@x" }, score: 3 },
        ],
        [{ address: { name: "A", address: "A@x" }, score: 2 }],
      ]),
    ).toEqual([{ address: "b@x" }, { name: "A", address: "A@x" }]);
  });
});

describe("CardDavAddressBooks", () => {
  it("searches the login's address books and follows changes", async () => {
    let now = 0;
    const dav = fakeDavServer({
      connected: [KEY],
      addressBooks: { contacts: { "anna.vcf": anna, "max.vcf": max } },
    });
    const servers = createCalendarServers(dav.bridge);
    const books = new CardDavAddressBooks({
      bridge: dav.bridge,
      key: KEY,
      servers,
      now: () => now,
    });
    expect(await books.home()).toBe(DAV_CONTACTS);
    expect(
      (await books.search("an")).map((match) => match.address.address),
    ).toEqual(["anna@example.org", "anna.berger@work.example"]);

    dav.editCard("contacts", "jurgen.vcf", jurgen);
    now += 60_000;
    expect(
      (await books.search("jü")).map((match) => match.address.address),
    ).toEqual(["j.oe@example.at"]);
  });

  it("looks for the address books of servers set up before contacts, once", async () => {
    const dav = fakeDavServer({
      connected: [KEY],
      contactsChecked: false,
      addressBooks: { contacts: { "max.vcf": max } },
    });
    const servers = createCalendarServers(dav.bridge);
    await servers.ready;
    expect(servers.info(KEY)?.contactsChecked).toBe(false);
    const books = new CardDavAddressBooks({
      bridge: dav.bridge,
      key: KEY,
      servers,
    });
    expect((await books.search("max")).map((m) => m.address.name)).toEqual([
      "Max Huber",
    ]);
    expect(dav.bridge.findContacts).toHaveBeenCalledTimes(1);
    expect(servers.info(KEY)).toMatchObject({
      contactsChecked: true,
      contacts: DAV_CONTACTS,
    });
    await books.home();
    expect(dav.bridge.findContacts).toHaveBeenCalledTimes(1);
  });

  it("has nothing without an address book", async () => {
    const dav = fakeDavServer({ connected: [KEY] });
    const servers = createCalendarServers(dav.bridge);
    const books = new CardDavAddressBooks({
      bridge: dav.bridge,
      key: KEY,
      servers,
    });
    expect(await books.search("anna")).toEqual([]);
  });
});
