/**
 * WebDAV and CalDAV (RFC 4918, 4791, 6578) as far as action0 needs them:
 * request bodies, and the `multistatus` answers parsed with DOMParser.
 */

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const CARDDAV = "urn:ietf:params:xml:ns:carddav";
export const CALSERVER = "http://calendarserver.org/ns/";
export const APPLE = "http://apple.com/ns/ical/";

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const NAMESPACES = `xmlns:d="${DAV}" xmlns:c="${CALDAV}" xmlns:card="${CARDDAV}" xmlns:cs="${CALSERVER}" xmlns:a="${APPLE}"`;

/** PROPFIND for the calendars of a calendar home (Depth: 1). */
export const CALENDARS_PROPFIND = `${XML_HEAD}
<d:propfind ${NAMESPACES}>
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <a:calendar-color/>
    <a:calendar-order/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
    <d:sync-token/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

/** PROPFIND for the address books of an address book home (Depth: 1). */
export const ADDRESSBOOKS_PROPFIND = `${XML_HEAD}
<d:propfind ${NAMESPACES}>
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:sync-token/>
  </d:prop>
</d:propfind>`;

/** PROPFIND for the ETags of a collection's objects (Depth: 1), when it has no change list. */
export const ETAGS_PROPFIND = `${XML_HEAD}
<d:propfind ${NAMESPACES}>
  <d:prop>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

/** The changes since `token` ("" for everything): RFC 6578. */
export function syncCollection(token: string): string {
  return `${XML_HEAD}
<d:sync-collection ${NAMESPACES}>
  <d:sync-token>${escapeXml(token)}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:sync-collection>`;
}

/** The objects at these hrefs, with their ETags: events, or contacts (vCards). */
export function multiget(
  hrefs: readonly string[],
  kind: "calendar" | "addressbook" = "calendar",
): string {
  const report =
    kind === "calendar" ? "c:calendar-multiget" : "card:addressbook-multiget";
  const data = kind === "calendar" ? "c:calendar-data" : "card:address-data";
  return `${XML_HEAD}
<${report} ${NAMESPACES}>
  <d:prop>
    <d:getetag/>
    <${data}/>
  </d:prop>
${hrefs.map((href) => `  <d:href>${escapeXml(href)}</d:href>`).join("\n")}
</${report}>`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One `<d:response>` of a multistatus: its href, status and found properties. */
export interface DavResource {
  /** Absolute URL, resolved against where the answer came from. */
  readonly url: string;
  /** The href as the server wrote it (for multiget). */
  readonly href: string;
  /** HTTP status of the resource itself (404 in a sync answer: removed). */
  readonly status?: number;
  /** Properties found (status 200), by `{namespace}name`. */
  readonly props: ReadonlyMap<string, Element>;
}

/** The key of a property in {@link DavResource.props}. */
export function propKey(namespace: string, name: string): string {
  return `{${namespace}}${name}`;
}

/** A multistatus answer's resources, and its new sync token if any. */
export function parseMultistatus(
  xml: string,
  base: string,
): { readonly resources: DavResource[]; readonly syncToken?: string } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0)
    return { resources: [] };
  const resources: DavResource[] = [];
  for (const response of childrenNamed(doc.documentElement, DAV, "response")) {
    const href = textOf(childNamed(response, DAV, "href"));
    if (!href) continue;
    const props = new Map<string, Element>();
    for (const propstat of childrenNamed(response, DAV, "propstat")) {
      const status = statusOf(textOf(childNamed(propstat, DAV, "status")));
      if (status !== undefined && (status < 200 || status >= 300)) continue;
      const prop = childNamed(propstat, DAV, "prop");
      if (!prop) continue;
      for (const element of Array.from(prop.children))
        props.set(
          propKey(element.namespaceURI ?? "", element.localName),
          element,
        );
    }
    const status = statusOf(textOf(childNamed(response, DAV, "status")));
    resources.push({
      url: resolve(href, base),
      href,
      ...(status === undefined ? {} : { status }),
      props,
    });
  }
  const token = textOf(childNamed(doc.documentElement, DAV, "sync-token"));
  return { resources, ...(token ? { syncToken: token } : {}) };
}

/** A property's text, trimmed. */
export function propText(
  resource: DavResource,
  namespace: string,
  name: string,
): string | undefined {
  const element = resource.props.get(propKey(namespace, name));
  const text = element?.textContent.trim();
  return text || undefined;
}

/** True if a property holds a child element with this name (`resourcetype` → `calendar`). */
export function propHas(
  resource: DavResource,
  namespace: string,
  name: string,
  childNamespace: string,
  child: string,
): boolean {
  const element = resource.props.get(propKey(namespace, name));
  return (
    element !== undefined &&
    element.getElementsByTagNameNS(childNamespace, child).length > 0
  );
}

/** The `comp` names of `supported-calendar-component-set` (upper case); undefined if absent. */
export function components(resource: DavResource): string[] | undefined {
  const element = resource.props.get(
    propKey(CALDAV, "supported-calendar-component-set"),
  );
  if (!element) return undefined;
  return Array.from(element.getElementsByTagNameNS(CALDAV, "comp")).map(
    (comp) => (comp.getAttribute("name") ?? "").toUpperCase(),
  );
}

/** URLs resolve against where the answer came from; hrefs are often paths. */
export function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** The same resource, however its path is written (`%40` or `@`, trailing slash). */
export function sameUrl(a: string, b: string): boolean {
  const normal = (url: string) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${decodeURIComponent(parsed.pathname).replace(/\/$/, "")}`;
    } catch {
      return url;
    }
  };
  return normal(a) === normal(b);
}

function childrenNamed(
  parent: Element,
  namespace: string,
  name: string,
): Element[] {
  return Array.from(parent.children).filter(
    (child) => child.namespaceURI === namespace && child.localName === name,
  );
}

function childNamed(
  parent: Element,
  namespace: string,
  name: string,
): Element | undefined {
  return childrenNamed(parent, namespace, name)[0];
}

function textOf(element: Element | undefined): string | undefined {
  const text = element?.textContent.trim();
  return text || undefined;
}

/** "HTTP/1.1 404 Not Found" → 404. */
function statusOf(line: string | undefined): number | undefined {
  const match = line === undefined ? null : /\s(\d{3})(\s|$)/.exec(line);
  return match ? Number(match[1]) : undefined;
}
