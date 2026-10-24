/**
 * A click in a mail's frame: if it's on a link the platform handles (the
 * desktop app opens web addresses in the browser and `mailto:` in a new
 * mail), the click does nothing else.
 */
export function followLinkClick(
  event: MouseEvent,
  followLink: (href: string) => boolean,
): void {
  // The frame's elements aren't `instanceof` this window's Element.
  const target = event.target;
  const link =
    target && "closest" in target
      ? (target as Element).closest<HTMLAnchorElement>("a[href]")
      : null;
  if (link && followLink(link.href)) event.preventDefault();
}
