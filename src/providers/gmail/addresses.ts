import type { EmailAddress } from "../../core/model";
import { decodeMimeWords } from "./mime";

/**
 * Parses an RFC 5322 address list such as
 * `"Doe, Jane" <jane@example.com>, bob@example.com, Team: a@x.org, b@x.org;`.
 *
 * Handles quoted display names (including commas and escapes), comments in
 * parentheses and groups. Invalid entries without an `@` are dropped.
 */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return splitTopLevel(value)
    .map(parseMailbox)
    .filter((address): address is EmailAddress => address !== undefined);
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

function parseMailbox(raw: string): EmailAddress | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  const angle = /<([^>]*)>/.exec(text);
  if (angle) {
    const address = (angle[1] ?? "").trim();
    if (!address.includes("@")) return undefined;
    const name = cleanName(
      text.slice(0, angle.index) + text.slice(angle.index + angle[0].length),
    );
    return name ? { name, address } : { address };
  }

  const comment = /\(([^)]*)\)/.exec(text);
  const address = text.replace(/\([^)]*\)/g, "").trim();
  if (!address.includes("@")) return undefined;
  const name = comment ? cleanName(comment[1] ?? "") : "";
  return name ? { name, address } : { address };
}

function cleanName(raw: string): string {
  let name = raw.replace(/\([^)]*\)/g, "").trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return decodeMimeWords(name).trim();
}
