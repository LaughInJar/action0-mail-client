import type { Birthday, PostalAddress } from "../../core/contacts";
import type { WritableBook } from "../../data/contacts";

/** A postal address as lines ("Hauptplatz 3", "8010 Graz", …). */
export function addressLines(address: PostalAddress): string[] {
  return [
    address.street,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.region,
    address.country,
  ]
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A birthday in the locale's words ("14 March 1988", "2 July"). */
export function formatBirthday(birthday: Birthday, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    ...(birthday.year === undefined ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(
    new Date(Date.UTC(birthday.year ?? 2000, birthday.month - 1, birthday.day)),
  );
}

/** "Contacts" or "work@example.com · Suppliers", as needed to tell books apart. */
export function bookLabel(
  entry: WritableBook,
  books: readonly WritableBook[],
): string {
  const ofSource = books.filter((other) => other.source === entry.source);
  const sources = new Set(books.map((other) => other.source.key));
  if (sources.size === 1) return entry.book.name;
  return ofSource.length > 1
    ? `${entry.source.label} · ${entry.book.name}`
    : entry.source.label;
}
