/**
 * Templates (canned replies): saved texts the composer inserts at the
 * cursor, with placeholders for the recipient's names.
 */
import type { AccountId } from "../core/ids";
import type { EmailAddress } from "../core/model";
import { escapeHtml, htmlToText } from "./html";

/** A saved text: what the composer inserts, and an optional subject. */
export interface MailTemplate {
  readonly id: string;
  readonly name: string;
  /** Fills an empty subject; "" for none. */
  readonly subject: string;
  /** Formatted like the composer's text. */
  readonly html: string;
  /** Only for this account's mail; none: for every account. */
  readonly accountId?: AccountId;
}

/** A recipient's names, for the placeholders. */
export interface RecipientNames {
  readonly first: string;
  readonly full: string;
}

/** `{first name}` / `{Vorname}` and `{name}` / `{Name}`, in any case. */
const PLACEHOLDER = /\{\s*(first\s+name|vorname|name)\s*\}/gi;

/**
 * The template's text with its placeholders replaced by the recipient's
 * names (escaped; empty when unknown).
 */
export function fillTemplate(html: string, names: RecipientNames): string {
  return html.replace(PLACEHOLDER, (_match, token: string) => {
    const kind = token.toLowerCase().replace(/\s+/g, " ");
    return escapeHtml(kind === "name" ? names.full : names.first);
  });
}

/**
 * The names of a recipient: the contact's where known, else from the
 * address's display name (its first word as the first name). An address
 * without a name gives none.
 */
export function recipientNames(
  to: EmailAddress | undefined,
  contact?: { readonly given: string; readonly full: string },
): RecipientNames {
  if (contact && (contact.given || contact.full))
    return {
      first: contact.given || contact.full.split(/\s+/)[0] || "",
      full: contact.full || contact.given,
    };
  const name = to?.name?.trim() ?? "";
  // "Berger, Anna": the part after the comma is the first name.
  const comma = /^([^,]+),\s*(.+)$/.exec(name);
  if (comma)
    return {
      first: comma[2]?.split(/\s+/)[0] ?? "",
      full: `${comma[2] ?? ""} ${comma[1] ?? ""}`.trim(),
    };
  return { first: name.split(/\s+/)[0] ?? "", full: name };
}

/** What a template is found by: its name, subject and text. */
export function templateSearchText(template: MailTemplate): string {
  return `${template.name} ${template.subject} ${htmlToText(template.html)}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** The templates for an account's mail: its own, then those for every account. */
export function templatesFor(
  templates: readonly MailTemplate[],
  accountId: AccountId | undefined,
): MailTemplate[] {
  return templates.filter(
    (template) =>
      template.accountId === undefined || template.accountId === accountId,
  );
}
