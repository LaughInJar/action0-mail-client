import { skipToken, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { initialsOf, type Contact } from "../../core/contacts";
import type { ContactSource } from "../../data/contacts";
import { queryKeys } from "../../data/keys";

/** A colour for initials, the same for the same name. */
function colorOf(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return `hsl(${String(Math.abs(hash) % 360)} 45% 42%)`;
}

/**
 * A contact's picture, or its initials on a colour of its name. Pictures
 * the provider has to be asked for (Outlook's) load only with `fetch`
 * (the open contact), as object URLs kept for the session.
 */
export function ContactAvatar({
  source,
  contact,
  name,
  large = false,
  fetch = false,
}: {
  source: ContactSource;
  contact: Contact;
  name: string;
  large?: boolean;
  fetch?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const fetched = useQuery({
    queryKey: queryKeys.contactPhoto(source.key, contact.id),
    queryFn:
      fetch && contact.photo?.kind === "fetch"
        ? async ({ signal }) => {
            const blob = await source.provider.photo(contact, signal);
            return blob ? URL.createObjectURL(blob) : null;
          }
        : skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const url =
    contact.photo?.kind === "url" ? contact.photo.url : (fetched.data ?? null);
  const size = large ? "size-16 text-xl" : "size-9 text-sm";
  if (url && broken !== url)
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setBroken(url);
        }}
        className={`${size} shrink-0 rounded-full bg-zinc-200 object-cover dark:bg-zinc-800`}
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: colorOf(name) }}
      className={`${size} grid shrink-0 place-items-center rounded-full font-semibold text-white`}
    >
      {initialsOf(name) || "?"}
    </span>
  );
}
