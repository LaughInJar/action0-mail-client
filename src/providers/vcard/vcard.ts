/**
 * vCard (RFC 2426 / 6350, and the older 2.1) for contacts: reading cards
 * into {@link ContactFields}, changing a card in place (only what changed
 * is rewritten; every other line stays byte for byte), writing new cards,
 * and the .vcf import and export ({@link createContactCards}). Lines are
 * split and folded here; each property is read with ical.js.
 */
import {
  asContactGroupId,
  displayNameOf,
  EMPTY_FIELDS,
  type Birthday,
  type CardToWrite,
  type ContactCards,
  type ContactFields,
  type ParsedCard,
  type PhoneKind,
  type PostalAddress,
  type Typed,
  type ValueKind,
} from "../../core/contacts";
import { loadIcal, type Ical } from "../ical/icalendar";

/** A vCard's version; 2.1 cards are read as 3.0 (see {@link fromVcard21}). */
export type CardVersion = "3.0" | "4.0";

/** A picture inside a card. */
export interface CardPhoto {
  /** "image/jpeg". */
  readonly mediaType: string;
  readonly base64: string;
}

/** What a card holds, as action0 reads it. */
export interface ReadCard {
  /** The fields; `groupIds` are the card's categories (by name). */
  readonly fields: ContactFields;
  /** FN, else built from the name. */
  readonly displayName: string;
  readonly version: CardVersion;
  readonly uid?: string;
  readonly photo?: CardPhoto;
  /** A group card (`KIND:group`, Apple's `X-ADDRESSBOOKSERVER-KIND:group`), not a person. */
  readonly isGroup: boolean;
  /** It has properties outside {@link ContactFields} (IM handles, anniversaries, …). */
  readonly more: boolean;
}

// ---------------------------------------------------------------- lines

/** One content line: its exact text (folds and line end included) and unfolded. */
interface Line {
  readonly raw: string;
  readonly text: string;
  /** Upper case, without the group ("EMAIL"). */
  readonly name: string;
  /** "item1" for `item1.EMAIL`, lower case. */
  readonly group?: string;
}

/** The content lines of a text, unfolded, each with its exact original text. */
function linesOf(text: string): Line[] {
  const lines: { raw: string; text: string }[] = [];
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    const [whole, content = "", end = ""] = match;
    if (whole === "") continue;
    const last = lines.at(-1);
    if (last && /^[ \t]/.test(content)) {
      last.raw += whole;
      last.text += content.slice(1);
    } else lines.push({ raw: whole, text: content });
    if (end === "") break;
  }
  return lines.map((line) => ({ ...line, ...nameOf(line.text) }));
}

function nameOf(text: string): { name: string; group?: string } {
  const head = /^[^;:]*/.exec(text)?.[0] ?? "";
  const dot = head.lastIndexOf(".");
  return dot < 0
    ? { name: head.toUpperCase() }
    : {
        name: head.slice(dot + 1).toUpperCase(),
        group: head.slice(0, dot).toLowerCase(),
      };
}

/** A line's property as ical.js reads it: `[name, params, type, ...values]`. */
type JCard = [string, Record<string, unknown>, string, ...unknown[]];

function propertyOf(
  ICAL: Ical,
  version: CardVersion,
  line: Line,
): JCard | undefined {
  try {
    const design = ICAL.design.getDesignSet(
      version === "4.0" ? "vcard" : "vcard3",
    );
    return ICAL.Property.fromString(line.text, design).toJSON() as JCard;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(text).filter(Boolean).join(" ")
      : "";

/** A structured value's components ("N", "ADR", "ORG"). */
const components = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text) : [text(value)];

/** A parameter's values, lower case (`TYPE=HOME,pref` → home, pref). */
function paramValues(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  const list = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return list
    .flatMap((item) => (typeof item === "string" ? item.split(",") : []))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 2.1

const ENCODINGS = new Set(["quoted-printable", "base64", "b", "8bit", "7bit"]);

/**
 * A vCard 2.1 card as 3.0: bare types become `TYPE=`, quoted-printable
 * and character sets are decoded, base64 becomes `ENCODING=b`.
 */
export function fromVcard21(card: string): string {
  const out: string[] = [];
  const physical = card.split(/\r\n|\n|\r/);
  let index = 0;
  while (index < physical.length) {
    let line = physical[index++] ?? "";
    // Folded (2.1 folds before whitespace too) and quoted-printable soft breaks.
    for (;;) {
      const next = physical[index];
      if (next === undefined) break;
      const quoted = /quoted-printable/i.test(line);
      if (quoted && line.endsWith("=")) line = line.slice(0, -1) + next;
      else if (!quoted && /^[ \t]/.test(next)) line += next.slice(1);
      else break;
      index++;
    }
    if (line.trim() === "") continue;
    out.push(convert21(line));
  }
  return `${out.join("\r\n")}\r\n`;
}

function convert21(line: string): string {
  const colon = line.indexOf(":");
  if (colon < 0) return line;
  const [head = "", ...rawParams] = line.slice(0, colon).split(";");
  let value = line.slice(colon + 1);
  const { name } = nameOf(head);
  if (name === "VERSION") return "VERSION:3.0";
  const types: string[] = [];
  const params: [string, string][] = [];
  let encoding = "";
  let charset = "utf-8";
  for (const param of rawParams) {
    const equals = param.indexOf("=");
    const key = (equals < 0 ? "" : param.slice(0, equals)).toLowerCase();
    const raw = equals < 0 ? param : param.slice(equals + 1);
    if (key === "encoding" || (key === "" && ENCODINGS.has(raw.toLowerCase())))
      encoding = raw.toLowerCase();
    else if (key === "charset") charset = raw;
    else if (key === "type" || key === "") types.push(...raw.split(","));
    else params.push([key.toUpperCase(), raw]);
  }
  const lists = name === "CATEGORIES" || name === "NICKNAME";
  if (encoding === "quoted-printable") {
    value = escapeDecoded(name, decodeQuotedPrintable(value, charset));
  } else if (encoding === "base64" || encoding === "b") {
    params.unshift(["ENCODING", "b"]);
    value = value.replace(/\s+/g, "");
  } else if (!lists) {
    // 2.1 has no lists: a comma is just a comma.
    value = value.replace(/(?<!\\),/g, "\\,");
  }
  const typed = types.length
    ? [["TYPE", types.map((type) => type.toUpperCase()).join(",")] as const]
    : [];
  return foldLine(
    `${head}${[...typed, ...params].map(([key, v]) => `;${key}=${v}`).join("")}:${value}`,
  ).replace(/\r\n$/, "");
}

/** Quoted-printable bytes as text in their character set. */
function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < value.length; at++) {
    const char = value[at];
    const hex = value.slice(at + 1, at + 3);
    if (char === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      at += 2;
    } else {
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
    }
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(new Uint8Array(bytes));
}

/** Decoded 2.1 text escaped as 3.0 wants it (structured ones keep their `;`). */
function escapeDecoded(name: string, value: string): string {
  const structured = name === "N" || name === "ADR" || name === "ORG";
  const lists = name === "CATEGORIES" || name === "NICKNAME";
  const escaped = value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n");
  return (lists ? escaped : escaped.replace(/,/g, "\\,")).replace(
    /;/g,
    structured ? ";" : "\\;",
  );
}

// ---------------------------------------------------------------- reading

/** Properties action0 reads, or that carry nothing a contact would miss. */
const KNOWN = new Set([
  "BEGIN",
  "END",
  "VERSION",
  "PRODID",
  "UID",
  "REV",
  "FN",
  "N",
  "NICKNAME",
  "EMAIL",
  "TEL",
  "ORG",
  "TITLE",
  "ADR",
  "LABEL",
  "BDAY",
  "URL",
  "NOTE",
  "CATEGORIES",
  "PHOTO",
  "X-ABLABEL",
  "KIND",
  "X-ADDRESSBOOKSERVER-KIND",
  "CLIENTPIDMAP",
  "X-ABUID",
  "X-ABSHOWAS",
  "SORT-STRING",
]);

/** Apple's standard labels (`_$!<Mobile>!$_`) as kinds. */
const APPLE_KINDS: Record<string, PhoneKind> = {
  mobile: "mobile",
  home: "home",
  work: "work",
  other: "other",
};

/** One value of a list family, with the lines it came from. */
interface Entry<T> {
  readonly value: T;
  readonly lines: readonly number[];
}

/** A card, read line by line (what {@link editCard} needs to keep lines). */
interface Parsed {
  readonly lines: readonly Line[];
  readonly version: CardVersion;
  readonly read: ReadCard;
  readonly emails: readonly Entry<Typed<ValueKind>>[];
  readonly phones: readonly Entry<Typed<PhoneKind>>[];
  readonly addresses: readonly Entry<PostalAddress>[];
  readonly websites: readonly Entry<Typed<ValueKind>>[];
  /** Line indexes by property name. */
  readonly byName: ReadonlyMap<string, readonly number[]>;
  /** The N line's prefix and suffix, kept when the name changes. */
  readonly nameRest: readonly string[];
  /** ORG's units after the department. */
  readonly orgRest: readonly string[];
}

function versionOf(lines: readonly Line[]): string {
  const line = lines.find((candidate) => candidate.name === "VERSION");
  return line?.text.slice(line.text.indexOf(":") + 1).trim() ?? "3.0";
}

function parse(ICAL: Ical, card: string): Parsed {
  const lines = linesOf(card);
  const version: CardVersion = versionOf(lines) === "4.0" ? "4.0" : "3.0";
  const labels = new Map<string, { label: string; index: number }>();
  lines.forEach((line, index) => {
    if (line.name === "X-ABLABEL" && line.group) {
      const property = propertyOf(ICAL, version, line);
      labels.set(line.group, { label: text(property?.[3]).trim(), index });
    }
  });
  /** The kind and label of a value from its TYPE and Apple label. */
  const typeOf = <K extends string>(
    line: Line,
    params: Record<string, unknown>,
    kinds: readonly K[],
    fallback: K,
  ): { kind: K; label?: string; lines: number[] } => {
    const types = paramValues(params, "type");
    const own = lines.indexOf(line);
    const apple = line.group ? labels.get(line.group) : undefined;
    const used = apple ? [own, apple.index] : [own];
    const appleMatch = apple ? /^_\$!<(.+)>!\$_$/.exec(apple.label) : null;
    if (apple && appleMatch) {
      const name = (appleMatch[1] ?? "").toLowerCase();
      const kind = APPLE_KINDS[name] as K | undefined;
      if (kind && kinds.includes(kind)) return { kind, lines: used };
      if (name === "homepage" && kinds.includes("other" as K))
        return { kind: "other" as K, lines: used };
    }
    const kind =
      (kinds.includes("mobile" as K) && types.includes("cell")
        ? ("mobile" as K)
        : undefined) ??
      kinds.find((candidate) => types.includes(candidate)) ??
      fallback;
    const label =
      apple && !appleMatch && apple.label
        ? apple.label
        : appleMatch
          ? appleMatch[1]
          : types.includes("fax")
            ? "Fax"
            : types.includes("pager")
              ? "Pager"
              : undefined;
    return { kind, lines: used, ...(label ? { label } : {}) };
  };

  const emails: Entry<Typed<ValueKind>>[] = [];
  const phones: Entry<Typed<PhoneKind>>[] = [];
  const addresses: Entry<PostalAddress>[] = [];
  const websites: Entry<Typed<ValueKind>>[] = [];
  const byName = new Map<string, number[]>();
  let fn = "";
  let name = { given: "", middle: "", family: "" };
  let nameRest: string[] = [];
  let nickname = "";
  let organization = { company: "", title: "", department: "" };
  let orgRest: string[] = [];
  let birthday: Birthday | undefined;
  let notes = "";
  const categories: string[] = [];
  let photo: CardPhoto | undefined;
  let uid: string | undefined;
  let isGroup = false;
  let more = false;
  const valueKinds = ["home", "work", "other"] as const;
  const phoneKinds = ["mobile", "home", "work", "other"] as const;

  lines.forEach((line, index) => {
    byName.set(line.name, [...(byName.get(line.name) ?? []), index]);
    if (!KNOWN.has(line.name) && line.name !== "") more = true;
    if (line.name === "BEGIN" || line.name === "END" || line.name === "")
      return;
    const property = propertyOf(ICAL, version, line);
    if (!property) return;
    const [, params, , ...values] = property;
    const first = values[0];
    switch (line.name) {
      case "FN":
        fn = text(first).trim();
        break;
      case "N": {
        const [family = "", given = "", middle = "", ...rest] =
          components(first);
        name = {
          given: given.trim(),
          middle: middle.trim(),
          family: family.trim(),
        };
        nameRest = rest;
        break;
      }
      case "NICKNAME":
        nickname ||= values.map(text).filter(Boolean).join(", ").trim();
        break;
      case "EMAIL": {
        const value = text(first).trim();
        if (!value) break;
        const { lines: used, ...typed } = typeOf(
          line,
          params,
          valueKinds,
          "other",
        );
        emails.push({ value: { value, ...typed }, lines: used });
        break;
      }
      case "TEL": {
        const value = text(first).replace(/^tel:/i, "").trim();
        if (!value) break;
        const { lines: used, ...typed } = typeOf(
          line,
          params,
          phoneKinds,
          "other",
        );
        phones.push({ value: { value, ...typed }, lines: used });
        break;
      }
      case "ADR": {
        const [
          pobox = "",
          extended = "",
          street = "",
          city = "",
          region = "",
          postalCode = "",
          country = "",
        ] = components(first);
        const { lines: used, ...typed } = typeOf(
          line,
          params,
          valueKinds,
          "other",
        );
        const address: PostalAddress = {
          street: [pobox, extended, street]
            .map((part) => part.trim())
            .filter(Boolean)
            .join("\n"),
          city: city.trim(),
          region: region.trim(),
          postalCode: postalCode.trim(),
          country: country.trim(),
          ...typed,
        };
        if (
          address.street ||
          address.city ||
          address.region ||
          address.postalCode ||
          address.country
        )
          addresses.push({ value: address, lines: used });
        break;
      }
      case "URL": {
        const value = text(first).trim();
        if (!value) break;
        const { lines: used, ...typed } = typeOf(
          line,
          params,
          valueKinds,
          "other",
        );
        websites.push({ value: { value, ...typed }, lines: used });
        break;
      }
      case "ORG": {
        const [company = "", department = "", ...rest] = components(first);
        organization = {
          ...organization,
          company: company.trim(),
          department: department.trim(),
        };
        orgRest = rest;
        break;
      }
      case "TITLE":
        organization = { ...organization, title: text(first).trim() };
        break;
      case "BDAY":
        birthday = birthdayOf(line, params) ?? birthday;
        break;
      case "NOTE":
        notes = notes ? `${notes}\n\n${text(first)}` : text(first);
        break;
      case "CATEGORIES":
        for (const value of values) {
          const category = text(value).trim();
          if (category && !categories.includes(category))
            categories.push(category);
        }
        break;
      case "PHOTO":
        photo ??= photoOf(params, text(first));
        break;
      case "UID":
        uid = text(first).trim() || undefined;
        break;
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND":
        if (text(first).trim().toLowerCase() === "group") isGroup = true;
        break;
    }
  });

  const fields: ContactFields = {
    ...EMPTY_FIELDS,
    name,
    nickname,
    emails: emails.map((entry) => entry.value),
    phones: phones.map((entry) => entry.value),
    organization,
    addresses: addresses.map((entry) => entry.value),
    ...(birthday ? { birthday } : {}),
    websites: websites.map((entry) => entry.value),
    notes: notes.trim(),
    groupIds: categories.map(asContactGroupId),
  };
  return {
    lines,
    version,
    read: {
      fields,
      displayName: fn || displayNameOf(fields),
      version,
      ...(uid ? { uid } : {}),
      ...(photo ? { photo } : {}),
      isGroup,
      more,
    },
    emails,
    phones,
    addresses,
    websites,
    byName,
    nameRest,
    orgRest,
  };
}

/** BDAY in any of its forms; a year left out (`--MMDD`, Apple's 1604) is none. */
function birthdayOf(
  line: Line,
  params: Record<string, unknown>,
): Birthday | undefined {
  const raw = line.text.slice(line.text.indexOf(":") + 1).trim();
  const noYear = /^--(\d{2})-?(\d{2})/.exec(raw);
  if (noYear) return dayOf(undefined, noYear[1], noYear[2]);
  const full = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(raw);
  if (!full) return undefined;
  const omitted = params["x-apple-omit-year"];
  const year = Number(full[1]);
  const yearless =
    (typeof omitted === "string" && Number(omitted) === year) ||
    year === 1604 ||
    year === 0;
  return dayOf(yearless ? undefined : year, full[2], full[3]);
}

function dayOf(
  year: number | undefined,
  month: string | undefined,
  day: string | undefined,
): Birthday | undefined {
  const m = Number(month);
  const d = Number(day);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return undefined;
  return { ...(year === undefined ? {} : { year }), month: m, day: d };
}

/** An embedded picture (base64 or a `data:` URL); pictures elsewhere are left alone. */
function photoOf(
  params: Record<string, unknown>,
  value: string,
): CardPhoto | undefined {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value.trim());
  if (data) {
    if (!data[2]) return undefined;
    return {
      mediaType: data[1] ?? "image/jpeg",
      base64: (data[3] ?? "").replace(/\s+/g, ""),
    };
  }
  const encoding = paramValues(params, "encoding");
  if (!encoding.includes("b") && !encoding.includes("base64")) return undefined;
  const type = paramValues(params, "type")[0] ?? "jpeg";
  return {
    mediaType: type.includes("/") ? type : `image/${type}`,
    base64: value.replace(/\s+/g, ""),
  };
}

/** The cards of a .vcf text, each exactly as written (2.1 ones too). */
export function splitCards(vcf: string): string[] {
  const cards: string[] = [];
  const pattern = /BEGIN:VCARD[\s\S]*?END:VCARD[^\S\r\n]*(\r\n|\n|\r|$)/gi;
  for (const match of vcf.matchAll(pattern)) cards.push(match[0]);
  return cards;
}

/** A card's version as written ("2.1", "3.0", "4.0"). */
export function cardVersion(card: string): string {
  return versionOf(linesOf(card));
}

/**
 * A card (3.0 or 4.0; a 2.1 one is converted first) as action0 reads it;
 * undefined if it isn't a vCard.
 */
export function readCard(ICAL: Ical, card: string): ReadCard | undefined {
  const text = cardVersion(card) === "2.1" ? fromVcard21(card) : card;
  if (!/^\s*BEGIN:VCARD/i.test(text)) return undefined;
  return parse(ICAL, text).read;
}

/** A card's fields (see {@link readCard}). */
export function fieldsOfCard(
  ICAL: Ical,
  card: string,
): ContactFields | undefined {
  return readCard(ICAL, card)?.fields;
}

// ---------------------------------------------------------------- writing

/** Text escaped for a vCard value (`;` and `,` too, which split values). */
function escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Folds a line at 75 octets (UTF-8), with CRLF. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return `${parts.join("\r\n ")}\r\n`;
}

/** A parameter value, quoted when it has to be. */
const paramValue = (value: string) =>
  /[:;,"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value;

interface NewLine {
  readonly name: string;
  readonly group?: string;
  readonly params?: readonly (readonly [string, string])[];
  /** Escaped already. */
  readonly value: string;
}

function lineOf({ name, group, params = [], value }: NewLine): string {
  return foldLine(
    `${group ? `${group}.` : ""}${name}${params
      .map(([key, v]) => `;${key}=${v}`)
      .join("")}:${value}`,
  );
}

/** Writes values the way a version wants them. */
class Writer {
  readonly #version: CardVersion;
  #nextGroup: number;

  constructor(version: CardVersion, groupsInUse: Iterable<string>) {
    this.#version = version;
    let highest = 0;
    for (const group of groupsInUse) {
      const n = /^item(\d+)$/i.exec(group);
      if (n) highest = Math.max(highest, Number(n[1]));
    }
    this.#nextGroup = highest + 1;
  }

  #types(types: readonly string[]): (readonly [string, string])[] {
    if (types.length === 0) return [];
    const cased = types.map((type) =>
      this.#version === "3.0" ? type.toUpperCase() : type.toLowerCase(),
    );
    return [["TYPE", cased.map(paramValue).join(",")]];
  }

  /** A typed value, with Apple's label line for a label TYPE can't say. */
  #typed(
    name: string,
    value: string,
    types: readonly string[],
    label: string | undefined,
    labelled: boolean,
  ): string {
    if (!label || !labelled)
      return lineOf({ name, params: this.#types(types), value });
    const group = `item${String(this.#nextGroup++)}`;
    return (
      lineOf({ name, group, params: this.#types(types), value }) +
      lineOf({ name: "X-ABLabel", group, value: escape(label) })
    );
  }

  email(email: Typed<ValueKind>): string {
    const kind = email.kind === "other" ? [] : [email.kind];
    return this.#typed(
      "EMAIL",
      escape(email.value),
      this.#version === "3.0" ? ["INTERNET", ...kind] : kind,
      email.label,
      true,
    );
  }

  phone(phone: Typed<PhoneKind>): string {
    const label = phone.label?.toLowerCase();
    const special = label === "fax" || label === "pager" ? [label] : [];
    const kind =
      phone.kind === "mobile"
        ? ["cell"]
        : phone.kind === "other"
          ? []
          : [phone.kind];
    return this.#typed(
      "TEL",
      escape(phone.value),
      [...kind, ...special],
      phone.label,
      special.length === 0,
    );
  }

  address(address: PostalAddress): string {
    const value = [
      "",
      "",
      address.street,
      address.city,
      address.region,
      address.postalCode,
      address.country,
    ]
      .map(escape)
      .join(";");
    return this.#typed(
      "ADR",
      value,
      address.kind === "other" ? [] : [address.kind],
      address.label,
      true,
    );
  }

  website(site: Typed<ValueKind>): string {
    return this.#typed(
      "URL",
      site.value.replace(/\r?\n/g, ""),
      site.kind === "other" ? [] : [site.kind],
      site.label,
      true,
    );
  }

  birthday(birthday: Birthday): string {
    const mm = String(birthday.month).padStart(2, "0");
    const dd = String(birthday.day).padStart(2, "0");
    if (birthday.year !== undefined) {
      const yyyy = String(birthday.year).padStart(4, "0");
      return lineOf({
        name: "BDAY",
        value:
          this.#version === "4.0" ? `${yyyy}${mm}${dd}` : `${yyyy}-${mm}-${dd}`,
      });
    }
    return this.#version === "4.0"
      ? lineOf({ name: "BDAY", value: `--${mm}${dd}` })
      : lineOf({
          name: "BDAY",
          params: [["X-APPLE-OMIT-YEAR", "1604"]],
          value: `1604-${mm}-${dd}`,
        });
  }

  photo(photo: CardPhoto): string {
    if (this.#version === "4.0")
      return lineOf({
        name: "PHOTO",
        value: `data:${photo.mediaType};base64,${photo.base64}`,
      });
    const type = (photo.mediaType.split("/")[1] ?? "jpeg").toUpperCase();
    return lineOf({
      name: "PHOTO",
      params: [
        ["ENCODING", "b"],
        ["TYPE", type],
      ],
      value: photo.base64,
    });
  }
}

/** REV as written now. */
function revision(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

const NAME_LINE = (fields: ContactFields, rest: readonly string[] = []) =>
  lineOf({
    name: "N",
    value: [
      fields.name.family,
      fields.name.given,
      fields.name.middle,
      rest[0] ?? "",
      rest[1] ?? "",
    ]
      .map(escape)
      .join(";"),
  });

const ORG_LINE = (fields: ContactFields, rest: readonly string[] = []) =>
  lineOf({
    name: "ORG",
    value: [
      fields.organization.company,
      fields.organization.department,
      ...rest,
    ]
      .map(escape)
      .join(";")
      .replace(/;+$/, ""),
  });

/** The text lines of a list of words (CATEGORIES). */
const LIST = (name: string, values: readonly string[]) =>
  lineOf({ name, value: values.map(escape).join(",") });

/** A new card (vCard 3.0) with these fields. */
export function newCard(
  fields: ContactFields,
  options: {
    readonly uid: string;
    readonly now: number;
    readonly photo?: CardPhoto;
    /** FN; built from the fields if absent. */
    readonly displayName?: string;
  },
): string {
  const writer = new Writer("3.0", []);
  const display = options.displayName?.trim() || displayNameOf(fields);
  const { company, title } = fields.organization;
  return [
    "BEGIN:VCARD\r\n",
    "VERSION:3.0\r\n",
    "PRODID:-//action0//action0//EN\r\n",
    lineOf({ name: "UID", value: escape(options.uid) }),
    lineOf({ name: "FN", value: escape(display) }),
    NAME_LINE(fields),
    fields.nickname.trim()
      ? lineOf({ name: "NICKNAME", value: escape(fields.nickname.trim()) })
      : "",
    ...fields.emails.map((email) => writer.email(email)),
    ...fields.phones.map((phone) => writer.phone(phone)),
    company || fields.organization.department ? ORG_LINE(fields) : "",
    title ? lineOf({ name: "TITLE", value: escape(title) }) : "",
    ...fields.addresses.map((address) => writer.address(address)),
    fields.birthday ? writer.birthday(fields.birthday) : "",
    ...fields.websites.map((site) => writer.website(site)),
    fields.notes.trim()
      ? lineOf({ name: "NOTE", value: escape(fields.notes.trim()) })
      : "",
    fields.groupIds.length > 0 ? LIST("CATEGORIES", fields.groupIds) : "",
    options.photo ? writer.photo(options.photo) : "",
    lineOf({ name: "REV", value: revision(options.now) }),
    "END:VCARD\r\n",
  ].join("");
}

/** JSON with sorted keys, so objects compare whatever order their keys were set in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}

const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * The card with `after` written into it. Only the properties whose values
 * changed are rewritten; values that stayed keep their lines (labels,
 * parameters, groups), and everything action0 doesn't read stays as it is.
 * VERSION stays first. With `photo`, the embedded photo is set (or removed:
 * `null`). Returns the text unchanged when nothing changed.
 */
export function editCard(
  ICAL: Ical,
  card: string,
  after: ContactFields,
  options: {
    readonly now?: number;
    readonly uid?: string;
    readonly photo?: CardPhoto | null;
  } = {},
): string {
  const parsed = parse(ICAL, card);
  const before = parsed.read.fields;
  const { lines, byName } = parsed;
  const groups = new Set(
    lines.flatMap((line) => (line.group ? [line.group] : [])),
  );
  const writer = new Writer(parsed.version, groups);
  /** Replacement text by line index ("" removes it). */
  const replaced = new Map<number, string>();
  /** Text to add before END:VCARD. */
  const added: string[] = [];
  let changed = false;

  /** Puts `text` where the family's first line was (or at the end), dropping its other lines. */
  const rewrite = (indexes: readonly number[], text: string) => {
    changed = true;
    const [first, ...rest] = [...indexes].sort((a, b) => a - b);
    if (first === undefined) {
      if (text) added.push(text);
      return;
    }
    replaced.set(first, text);
    for (const index of rest) replaced.set(index, "");
  };
  const indexesOf = (...names: string[]) =>
    names.flatMap((name) => byName.get(name) ?? []);

  /** A list family: unchanged values keep their lines, in the new order. */
  const list = <T>(
    entries: readonly Entry<T>[],
    next: readonly T[],
    write: (value: T) => string,
  ) => {
    if (
      sameJson(
        entries.map((entry) => entry.value),
        next,
      )
    )
      return;
    const unused = [...entries];
    const raws = next.map((value) => {
      const at = unused.findIndex((entry) => sameJson(entry.value, value));
      if (at < 0) return write(value);
      const [entry] = unused.splice(at, 1);
      return (entry?.lines ?? [])
        .map((index) => lines[index]?.raw ?? "")
        .map(withLineEnd)
        .join("");
    });
    const all = entries.flatMap((entry) => entry.lines);
    rewrite(all, raws.join(""));
  };

  // The name, and FN when it was derived from the fields (or the name changed).
  const nameChanged = !sameJson(before.name, after.name);
  if (nameChanged) rewrite(indexesOf("N"), NAME_LINE(after, parsed.nameRest));
  const oldDisplay = parsed.read.displayName;
  const fnLine = indexesOf("FN");
  const derived =
    fnLine.length === 0 ||
    nameChanged ||
    oldDisplay === displayNameOf(before) ||
    oldDisplay === "";
  const display = derived ? displayNameOf(after) : oldDisplay;
  if (display !== oldDisplay || fnLine.length === 0)
    rewrite(fnLine, lineOf({ name: "FN", value: escape(display) }));
  if (before.nickname !== after.nickname)
    rewrite(
      indexesOf("NICKNAME"),
      after.nickname.trim()
        ? lineOf({ name: "NICKNAME", value: escape(after.nickname.trim()) })
        : "",
    );
  list(parsed.emails, after.emails, (email) => writer.email(email));
  list(parsed.phones, after.phones, (phone) => writer.phone(phone));
  list(parsed.addresses, after.addresses, (address) => writer.address(address));
  list(parsed.websites, after.websites, (site) => writer.website(site));
  if (
    before.organization.company !== after.organization.company ||
    before.organization.department !== after.organization.department
  )
    rewrite(
      indexesOf("ORG"),
      after.organization.company || after.organization.department
        ? ORG_LINE(after, parsed.orgRest)
        : "",
    );
  if (before.organization.title !== after.organization.title)
    rewrite(
      indexesOf("TITLE"),
      after.organization.title
        ? lineOf({ name: "TITLE", value: escape(after.organization.title) })
        : "",
    );
  if (!sameJson(before.birthday, after.birthday))
    rewrite(
      indexesOf("BDAY"),
      after.birthday ? writer.birthday(after.birthday) : "",
    );
  if (before.notes !== after.notes.trim())
    rewrite(
      indexesOf("NOTE"),
      after.notes.trim()
        ? lineOf({ name: "NOTE", value: escape(after.notes.trim()) })
        : "",
    );
  if (!sameJson(before.groupIds, after.groupIds))
    rewrite(
      indexesOf("CATEGORIES"),
      after.groupIds.length > 0 ? LIST("CATEGORIES", after.groupIds) : "",
    );
  if (options.photo !== undefined) {
    const current = parsed.read.photo;
    const same =
      options.photo === null
        ? current === undefined
        : current?.base64 === options.photo.base64 &&
          current.mediaType === options.photo.mediaType;
    if (!same)
      rewrite(
        indexesOf("PHOTO"),
        options.photo ? writer.photo(options.photo) : "",
      );
  }
  if (options.uid && !parsed.read.uid) {
    changed = true;
    added.push(lineOf({ name: "UID", value: escape(options.uid) }));
  }
  if (!changed) return card;

  // Apple's labels of values that are gone go too.
  const kept = new Set<string>();
  lines.forEach((line, index) => {
    const text = replaced.get(index);
    if (line.group && line.name !== "X-ABLABEL" && text !== "")
      kept.add(line.group);
  });
  for (const raw of [...replaced.values(), ...added])
    for (const match of raw.matchAll(/^(item\d+)\./gim))
      kept.add((match[1] ?? "").toLowerCase());
  lines.forEach((line, index) => {
    if (
      line.name === "X-ABLABEL" &&
      line.group &&
      !kept.has(line.group) &&
      !replaced.has(index)
    )
      replaced.set(index, "");
  });

  const rev = lineOf({
    name: "REV",
    value: revision(options.now ?? Date.now()),
  });
  const revLines = indexesOf("REV");
  if (revLines.length > 0) rewrite(revLines, rev);
  else added.push(rev);

  const end = lines.findIndex((line) => line.name === "END");
  const out = lines.map((line, index) =>
    index === end
      ? added.join("") + line.raw
      : (replaced.get(index) ?? line.raw),
  );
  return end < 0 ? withLineEnd(out.join("")) + added.join("") : out.join("");
}

/** A raw line with a line end (the last line of a text may have none). */
function withLineEnd(raw: string): string {
  return raw === "" || /(\r\n|\n|\r)$/.test(raw) ? raw : `${raw}\r\n`;
}

/** A card with a UID (an imported card may have none), as 3.0 if it was 2.1. */
export function storableCard(
  ICAL: Ical,
  card: string,
  options: { readonly uid: string; readonly now: number },
): string {
  const text = cardVersion(card) === "2.1" ? fromVcard21(card) : card;
  const fields = parse(ICAL, text).read.fields;
  return editCard(ICAL, text, fields, options);
}

// ---------------------------------------------------------------- files

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A card's picture as a Blob. */
export function photoBlob(photo: CardPhoto): Blob {
  const binary = atob(photo.base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return new Blob([bytes], { type: photo.mediaType });
}

/** A card's picture as a `data:` URL. */
export function photoUrl(photo: CardPhoto): string {
  return `data:${photo.mediaType};base64,${photo.base64}`;
}

/** A Blob as a card's picture. */
export async function cardPhotoOf(blob: Blob): Promise<CardPhoto> {
  return { mediaType: blob.type || "image/jpeg", base64: await base64Of(blob) };
}

/** Reading and writing .vcf files with ical.js. */
export function createContactCards(
  options: { readonly now?: () => number } = {},
): ContactCards {
  const now = options.now ?? Date.now;
  return {
    parse: async (vcf) => {
      const ICAL = await loadIcal();
      return splitCards(vcf).flatMap((raw): ParsedCard[] => {
        const card = cardVersion(raw) === "2.1" ? fromVcard21(raw) : raw;
        let read: ReadCard;
        try {
          read = parse(ICAL, card).read;
        } catch {
          return [];
        }
        if (read.isGroup) return [];
        const { groupIds, ...rest } = read.fields;
        return [
          {
            fields: { ...rest, groupIds: [] },
            displayName: read.displayName,
            groups: groupIds,
            ...(read.photo ? { photo: photoBlob(read.photo) } : {}),
            more: read.more,
            card,
          },
        ];
      });
    },
    format: async (cards: readonly CardToWrite[]) => {
      const texts = await Promise.all(
        cards.map(async (card) => {
          if (card.raw) return withLineEnd(card.raw.trimEnd());
          const photo = card.photo ? await cardPhotoOf(card.photo) : undefined;
          return newCard(
            {
              ...card.fields,
              groupIds: card.groups.map(asContactGroupId),
            },
            {
              uid: crypto.randomUUID(),
              now: now(),
              displayName: card.displayName,
              ...(photo ? { photo } : {}),
            },
          );
        }),
      );
      return texts.join("");
    },
  };
}
