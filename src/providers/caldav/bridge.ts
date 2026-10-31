/**
 * What the apps' native side does for calendar servers (CalDAV): the
 * contract between `CaldavCalendarProvider` (and the setup dialog) and
 * `src-tauri/src/caldav` (implemented over Tauri commands in
 * `src/platform/native/caldav.ts`).
 *
 * The native side keeps the logins (in its vault, never handed to the UI),
 * finds servers, and carries requests: it adds the login only for the
 * server's own hosts, applies its trusted certificate, and follows
 * redirects within those hosts. The DAV and iCalendar logic is the
 * provider's.
 */
import type {
  CalendarServerCandidate,
  CalendarServerInfo,
  CalendarServerSetup,
} from "../../accounts/calendarServer";

/** A request to a calendar server. */
export interface DavRequest {
  /** `PROPFIND`, `REPORT`, `GET`, `PUT`, `DELETE`, `OPTIONS`. */
  readonly method: string;
  /** Absolute; must be on one of the server's hosts. */
  readonly url: string;
  /** `Depth`, `Content-Type`, `If-Match`, `If-None-Match`, `Prefer`, … */
  readonly headers?: Readonly<Record<string, string>>;
  /** XML or iCalendar text. */
  readonly body?: string;
}

/** The server's answer. */
export interface DavResponse {
  readonly status: number;
  /** Where the answer came from, after redirects (relative hrefs resolve against it). */
  readonly url: string;
  /** Lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * See the module docs. Requests reject with a `MailServerError` only when
 * there's no answer (`unreachable`, `tls`, `untrusted`), the source has no
 * login (`notFound`), or the address isn't on the server's hosts
 * (`server`); every HTTP status comes back as a {@link DavResponse}.
 */
export interface CaldavBridge {
  readonly discover: (
    address: string,
    mailHost?: string,
  ) => Promise<readonly CalendarServerCandidate[]>;
  readonly connect: (setup: CalendarServerSetup) => Promise<CalendarServerInfo>;
  readonly servers: () => Promise<readonly CalendarServerInfo[]>;
  readonly remove: (key: string) => Promise<void>;
  readonly forgetCertificate: (key: string) => Promise<void>;
  readonly request: (
    key: string,
    request: DavRequest,
    signal?: AbortSignal,
  ) => Promise<DavResponse>;
}
