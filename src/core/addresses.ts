import type { EmailAddress } from "./model";

/** One entry of an address list as typed or pasted, valid or not. */
export interface AddressEntry {
  /** The entry as written (trimmed). */
  readonly raw: string;
  /** The parsed address, if the entry is a valid one. */
  readonly address?: EmailAddress;
}

/** Loose check for `local@domain.tld`, as mail clients do before sending. */
export function isValidAddress(address: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(address);
}

/**
 * Parses an RFC 5322 address list such as
 * `"Doe, Jane" <jane@example.com>, bob@example.com, Team: a@x.org, b@x.org;`.
 *
 * Handles quoted display names (including commas and escapes), comments in
 * parentheses and groups. Invalid entries without an `@` are dropped.
 * `decodeName` decodes display names (e.g. RFC 2047 encoded words).
 */
export function parseAddressList(
  value: string | undefined,
  decodeName: (name: string) => string = (name) => name,
): EmailAddress[] {
  if (!value) return [];
  return splitTopLevel(value)
    .map((part) => parseMailbox(part, decodeName))
    .filter((address): address is EmailAddress => address !== undefined);
}

/**
 * Splits typed or pasted recipients into entries, keeping invalid ones so
 * they can be shown and fixed: `Anna <a@x.org>; nobody, b@y.com`.
 */
export function parseAddressInput(value: string): AddressEntry[] {
  return splitTopLevel(value.replace(/\r?\n/g, ","))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((raw) => {
      const address = parseMailbox(raw, (name) => name);
      return address && isValidAddress(address.address)
        ? { raw, address }
        : { raw };
    });
}

/** `Name <address>` (quoted where needed), or just the address. */
export function formatAddress({ name, address }: EmailAddress): string {
  if (!name) return address;
  const quoted = /[",;:<>()@[\]\\]/.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}"`
    : name;
  return `${quoted} <${address}>`;
}

/** Splits at commas and group delimiters that are outside quotes, brackets and comments. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  let commentDepth = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i] ?? "";
    if (inQuotes) {
      current += char;
      if (char === "\\") {
        current += value[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === "(") commentDepth++;
    else if (char === ")") commentDepth = Math.max(0, commentDepth - 1);
    else if (commentDepth === 0 && char === "<") angleDepth++;
    else if (commentDepth === 0 && char === ">")
      angleDepth = Math.max(0, angleDepth - 1);
    else if (commentDepth === 0 && angleDepth === 0) {
      if (char === ",") {
        parts.push(current);
        current = "";
        continue;
      }
      if (char === ":") {
        // Group display name: drop it.
        current = "";
        continue;
      }
      if (char === ";") {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseMailbox(
  raw: string,
  decodeName: (name: string) => string,
): EmailAddress | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  const angle = /<([^>]*)>/.exec(text);
  if (angle) {
    const address = (angle[1] ?? "").trim();
    if (!address.includes("@")) return undefined;
    const name = cleanName(
      text.slice(0, angle.index) + text.slice(angle.index + angle[0].length),
      decodeName,
    );
    return name ? { name, address } : { address };
  }

  const comment = /\(([^)]*)\)/.exec(text);
  const address = text.replace(/\([^)]*\)/g, "").trim();
  if (!address.includes("@")) return undefined;
  const name = comment ? cleanName(comment[1] ?? "", decodeName) : "";
  return name ? { name, address } : { address };
}

function cleanName(raw: string, decodeName: (name: string) => string): string {
  let name = raw.replace(/\([^)]*\)/g, "").trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return decodeName(name).trim();
}
