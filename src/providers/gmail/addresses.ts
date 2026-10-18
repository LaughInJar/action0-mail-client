import { parseAddressList as parseList } from "../../core/addresses";
import type { EmailAddress } from "../../core/model";
import { decodeMimeWords } from "./mime";

/**
 * Parses an address header (see the core parser), decoding RFC 2047
 * encoded words in display names.
 */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  return parseList(value, decodeMimeWords);
}
