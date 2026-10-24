import type { SharedContent } from "../../platform/types";

/**
 * What another app shared, as a `mailto:` link for a new mail (its files
 * are attached separately). Shared text goes into the body.
 */
export function shareMailto({ to, subject, text }: SharedContent): string {
  const fields = [
    ...(subject ? [`subject=${encodeURIComponent(subject)}`] : []),
    ...(text ? [`body=${encodeURIComponent(text)}`] : []),
  ];
  return `mailto:${to.map(encodeURIComponent).join(",")}${
    fields.length > 0 ? `?${fields.join("&")}` : ""
  }`;
}

/** A computed CSS colour (`rgb(9, 9, 11)`) as `#09090b`; white if it isn't one. */
export function hexColor(color: string): string {
  const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!parts) return "#ffffff";
  return `#${parts
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}
