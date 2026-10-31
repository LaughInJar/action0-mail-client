import {
  asAddressBookId,
  asContactGroupId,
  asContactId,
  displayNameOf,
  EMPTY_FIELDS,
  type Contact,
  type ContactFields,
  type PhoneKind,
  type ValueKind,
} from "../../core/contacts";
import { OUTLOOK_CATEGORY_COLORS } from "../microsoft/folders";
import type { FakeContactsData } from "./FakeContactsProvider";

/** What a demo contact has; everything else is empty. */
interface Seed {
  readonly id: string;
  readonly given?: string;
  readonly family?: string;
  readonly nickname?: string;
  readonly emails?: readonly (string | readonly [string, ValueKind])[];
  readonly phones?: readonly (readonly [string, PhoneKind])[];
  readonly company?: string;
  readonly title?: string;
  readonly department?: string;
  readonly city?: readonly [street: string, postalCode: string, city: string];
  readonly birthday?: readonly [month: number, day: number, year?: number];
  readonly website?: string;
  readonly notes?: string;
  readonly groups?: readonly string[];
  readonly book?: string;
  readonly photo?: string;
}

function contactOf(seed: Seed, defaultBook: string): Contact {
  const fields: ContactFields = {
    ...EMPTY_FIELDS,
    name: { given: seed.given ?? "", middle: "", family: seed.family ?? "" },
    nickname: seed.nickname ?? "",
    emails: (seed.emails ?? []).map((email) =>
      typeof email === "string"
        ? { value: email, kind: "home" }
        : { value: email[0], kind: email[1] },
    ),
    phones: (seed.phones ?? []).map(([value, kind]) => ({ value, kind })),
    organization: {
      company: seed.company ?? "",
      title: seed.title ?? "",
      department: seed.department ?? "",
    },
    addresses: seed.city
      ? [
          {
            street: seed.city[0],
            postalCode: seed.city[1],
            city: seed.city[2],
            region: "",
            country: "Austria",
            kind: "home",
          },
        ]
      : [],
    ...(seed.birthday
      ? {
          birthday: {
            month: seed.birthday[0],
            day: seed.birthday[1],
            ...(seed.birthday[2] ? { year: seed.birthday[2] } : {}),
          },
        }
      : {}),
    websites: seed.website ? [{ value: seed.website, kind: "work" }] : [],
    notes: seed.notes ?? "",
    groupIds: (seed.groups ?? []).map(asContactGroupId),
  };
  return {
    ...fields,
    id: asContactId(seed.id),
    addressBookId: asAddressBookId(seed.book ?? defaultBook),
    displayName: displayNameOf(fields),
    version: "1",
    ...(seed.photo ? { photo: { kind: "url", url: seed.photo } } : {}),
  };
}

/** A small landscape as a `data:` URL, the demo's stand-in for a photo. */
function picture(sky: string, hill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${sky}"/><circle cx="46" cy="18" r="8" fill="#fde68a"/><path d="M0 50 L20 28 L34 42 L46 32 L64 48 V64 H0 Z" fill="${hill}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const STARRED = "starred";
const FAMILY = "family";
const HIKING = "hiking";
const WORK = "work";

/** Contacts of the demo account: Google-like, with labels and Other contacts. */
export function createDemoContacts(): FakeContactsData {
  const seeds: Seed[] = [
    {
      id: "anna",
      given: "Anna",
      family: "Berger",
      emails: [["anna.berger@example.org", "work"], "anna.b@mail.example"],
      phones: [
        ["+43 664 123 4567", "mobile"],
        ["+43 1 234 5678", "work"],
      ],
      company: "Berger & Partner",
      title: "Project lead",
      city: ["Neubaugasse 12", "1070", "Vienna"],
      birthday: [3, 14, 1988],
      website: "https://berger-partner.example",
      notes: "Prefers calls in the morning.",
      groups: [STARRED, WORK],
      photo: picture("#bae6fd", "#16a34a"),
    },
    {
      id: "lukas",
      given: "Lukas",
      family: "Hofer",
      emails: ["lukas@example.net"],
      phones: [["0676 555 0101", "mobile"]],
      groups: [HIKING],
    },
    {
      // A duplicate of Lukas: the same mobile number, written differently.
      id: "lukas-2",
      given: "Lukas",
      family: "Hofer",
      emails: [["lukas.hofer@work.example", "work"]],
      phones: [["+43 676 5550101", "mobile"]],
      company: "Hofer Bau",
    },
    {
      id: "mia",
      given: "Mia",
      family: "Steiner",
      emails: ["mia.steiner@example.com"],
      phones: [["+43 650 777 1234", "mobile"]],
      birthday: [7, 2],
      groups: [FAMILY, STARRED],
      photo: picture("#fecaca", "#b45309"),
    },
    {
      id: "jonas",
      given: "Jonas",
      family: "Gruber",
      emails: ["jonas.gruber@example.org"],
      company: "Gruber Design",
      title: "Designer",
      website: "https://gruber.example",
      groups: [WORK],
    },
    {
      id: "sophie",
      given: "Sophie",
      family: "Wagner",
      emails: ["sophie@example.net"],
      phones: [["+43 699 1122 3344", "mobile"]],
      city: ["Hauptplatz 3", "8010", "Graz"],
      groups: [HIKING],
    },
    {
      // A duplicate of Sophie: the same address.
      id: "sophie-2",
      given: "Sophie",
      family: "Wagner",
      nickname: "Sophie W.",
      emails: ["sophie@example.net"],
      notes: "Met at the hiking club's summer trip.",
    },
    {
      id: "felix",
      given: "Felix",
      family: "Mayer",
      emails: ["felix.mayer@example.com"],
      phones: [["+43 1 987 6543", "home"]],
      groups: [FAMILY],
      birthday: [11, 21, 1990],
    },
    {
      id: "lena",
      given: "Lena",
      family: "Huber",
      emails: ["lena.huber@example.org"],
      phones: [["+43 660 222 3333", "mobile"]],
      company: "City Library",
      title: "Librarian",
    },
    {
      id: "paul",
      given: "Paul",
      family: "Novak",
      emails: ["paul.novak@example.cz"],
      city: ["Národní 5", "110 00", "Prague"],
    },
    {
      id: "eva",
      given: "Eva",
      family: "Schmid",
      emails: ["eva.schmid@example.com", ["eva@schmid-law.example", "work"]],
      company: "Schmid Law",
      title: "Lawyer",
      groups: [WORK],
    },
    {
      id: "david",
      given: "David",
      family: "Fischer",
      emails: ["david.fischer@example.net"],
      phones: [["+43 664 444 5555", "mobile"]],
      groups: [HIKING],
    },
    {
      id: "julia",
      given: "Julia",
      family: "Weber",
      emails: ["julia.weber@example.org"],
      birthday: [1, 9, 1975],
      groups: [FAMILY],
    },
    {
      id: "max",
      given: "Max",
      family: "Bauer",
      emails: ["max@bauer.example"],
      phones: [["+43 512 33 44 55", "work"]],
      company: "Bauer Bikes",
      city: ["Maria-Theresien-Straße 1", "6020", "Innsbruck"],
    },
    {
      id: "nina",
      given: "Nina",
      family: "Koller",
      emails: ["nina.koller@example.com"],
      groups: [STARRED],
    },
    {
      id: "oliver",
      given: "Oliver",
      family: "Lang",
      emails: ["oliver.lang@example.net"],
      phones: [["+43 650 888 9999", "mobile"]],
    },
    {
      id: "clara",
      given: "Clara",
      family: "Pichler",
      emails: ["clara.pichler@example.org"],
      company: "Hiking club",
      title: "Treasurer",
      groups: [HIKING],
    },
    {
      id: "tobias",
      given: "Tobias",
      family: "Reiter",
      emails: ["tobias.reiter@example.com"],
    },
    {
      id: "jurgen",
      given: "Jürgen",
      family: "Öztürk",
      emails: ["juergen.oeztuerk@example.at"],
      phones: [["+43 316 12 34 56", "home"]],
    },
    {
      id: "pizza",
      company: "Pizzeria Bella",
      phones: [["+43 1 555 1234", "work"]],
      website: "https://bella.example",
    },
    {
      id: "doctor",
      given: "Maria",
      family: "Lechner",
      title: "General practitioner",
      phones: [["+43 1 333 2222", "work"]],
      city: ["Gumpendorfer Straße 40", "1060", "Vienna"],
    },
  ];
  const other: Contact[] = [
    {
      ...contactOf(
        { id: "o-billing", emails: ["billing@shop.example"] },
        "contacts",
      ),
      other: true,
    },
    {
      ...contactOf(
        {
          id: "o-hannah",
          given: "Hannah",
          family: "Zeller",
          emails: ["hannah.zeller@example.com"],
        },
        "contacts",
      ),
      other: true,
    },
    {
      ...contactOf(
        {
          id: "o-team",
          given: "Example",
          family: "Team",
          emails: ["team@example.com"],
        },
        "contacts",
      ),
      other: true,
    },
  ];
  return {
    flavor: "google",
    addressBooks: [
      {
        id: asAddressBookId("contacts"),
        name: "Contacts",
        readOnly: false,
        isDefault: true,
      },
    ],
    groups: [
      { id: asContactGroupId(STARRED), name: "Starred" },
      { id: asContactGroupId(FAMILY), name: "Family" },
      { id: asContactGroupId(HIKING), name: "Hiking club" },
      { id: asContactGroupId(WORK), name: "Work" },
    ],
    contacts: seeds.map((seed) => contactOf(seed, "contacts")),
    other,
  };
}

const category = (name: string, preset: number) => {
  const color = OUTLOOK_CATEGORY_COLORS[preset]?.background;
  return {
    id: asContactGroupId(name),
    name,
    ...(color ? { color } : {}),
  };
};

/** Contacts of the work demo account: Outlook-like, with folders and categories. */
export function createWorkDemoContacts(): FakeContactsData {
  const work = (address: string) => [address, "other"] as const;
  const seeds: Seed[] = [
    {
      id: "w-mira",
      given: "Mira",
      family: "Hofer",
      emails: [work("mira.hofer@work.example")],
      phones: [["+43 1 4000 101", "work"]],
      company: "Example Works",
      title: "Head of design",
      department: "Design",
      groups: ["Team"],
    },
    {
      id: "w-jonas",
      given: "Jonas",
      family: "Weber",
      emails: [work("jonas.weber@work.example")],
      phones: [
        ["+43 1 4000 102", "work"],
        ["+43 664 100 2000", "mobile"],
      ],
      company: "Example Works",
      title: "Developer",
      department: "Web",
      groups: ["Team"],
    },
    {
      id: "w-priya",
      given: "Priya",
      family: "Nair",
      emails: [work("priya.nair@work.example")],
      company: "Example Works",
      title: "Product manager",
      groups: ["Team"],
    },
    {
      id: "w-tom",
      given: "Tom",
      family: "Brandt",
      emails: [work("tom.brandt@work.example")],
      company: "Example Works",
      department: "Sales",
    },
    {
      // A duplicate of Tom: the same address.
      id: "w-tom-2",
      given: "Thomas",
      family: "Brandt",
      emails: [work("tom.brandt@work.example")],
      phones: [["+43 664 300 4000", "mobile"]],
    },
    {
      id: "w-it",
      company: "IT Service Desk",
      emails: [work("it@work.example")],
      phones: [["+43 1 4000 999", "work"]],
    },
    {
      id: "w-kaiser",
      given: "Stefan",
      family: "Kaiser",
      emails: [work("office@print-kaiser.example")],
      phones: [["+43 1 222 3344", "work"]],
      company: "Print Shop Kaiser",
      website: "https://print-kaiser.example",
      book: "suppliers",
      groups: ["Clients"],
    },
    {
      id: "w-alpen",
      company: "Alpen Catering",
      emails: [work("orders@alpen-catering.example")],
      book: "suppliers",
    },
  ];
  return {
    flavor: "outlook",
    addressBooks: [
      {
        id: asAddressBookId("contacts"),
        name: "Contacts",
        readOnly: false,
        isDefault: true,
      },
      {
        id: asAddressBookId("suppliers"),
        name: "Suppliers",
        readOnly: false,
        isDefault: false,
      },
    ],
    groups: [category("Team", 7), category("Clients", 4)],
    contacts: seeds.map((seed) => contactOf(seed, "contacts")),
  };
}
