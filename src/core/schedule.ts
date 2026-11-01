/**
 * Send later: the marker that keeps a scheduled draft's time (where the
 * server can't hold mail), the times offered, and when a mail counts as
 * missed.
 */
import type { AccountId, MailboxId } from "./ids";
import type { MessageSummary } from "./model";
import type { ProviderCapabilities } from "./provider";

/**
 * The header that marks a draft as scheduled:
 * `X-Action0-Send-At: 2026-11-03T07:00:00.000Z; by=<device>`. It stays in
 * the drafts mailbox; the mail is built without it when it's sent.
 */
export const SEND_AT_HEADER = "X-Action0-Send-At";

/** When a mail is to go out, and which action0 scheduled it. */
export interface Schedule {
  readonly sendAt: Date;
  /** The scheduling action0's device id (a random id per browser or app); opaque. */
  readonly by: string;
}

/** A scheduled draft's time and the action0 that scheduled it, as stored. */
export interface SendAtMarker {
  /** ISO 8601, UTC. */
  readonly sendAt: string;
  /** The scheduling action0's device id; opaque. */
  readonly by?: string;
}

/** The marker's header value. */
export function formatSendAtMarker({ sendAt, by }: Schedule): string {
  return `${sendAt.toISOString()}; by=${by}`;
}

/** Reads a marker's header value; `undefined` if it isn't one. */
export function parseSendAtMarker(
  value: string | undefined,
): SendAtMarker | undefined {
  if (!value) return undefined;
  const [time = "", ...rest] = value.split(";").map((part) => part.trim());
  const at = Date.parse(time);
  if (Number.isNaN(at)) return undefined;
  const by = rest
    .find((part) => part.startsWith("by="))
    ?.slice(3)
    .trim();
  return { sendAt: new Date(at).toISOString(), ...(by ? { by } : {}) };
}

/** A mail this late isn't sent unasked (the user is asked first). */
export const MISSED_AFTER_MS = 30 * 60_000;

/** Another action0 than the one that scheduled a mail waits this long before sending it. */
export const OTHERS_WAIT_MS = 2 * 60_000;

/** Whether a scheduled mail is too late to be sent unasked. */
export function isMissed(sendAt: string, now: number): boolean {
  return now - Date.parse(sendAt) > MISSED_AFTER_MS;
}

/** Whether this action0 sends a scheduled mail now (it's due, and not missed). */
export function isDue(
  mail: { readonly sendAt: string; readonly scheduledBy?: string },
  now: number,
  device: string,
): boolean {
  const at = Date.parse(mail.sendAt);
  const wait =
    mail.scheduledBy === undefined || mail.scheduledBy === device
      ? 0
      : OTHERS_WAIT_MS;
  return now >= at + wait && !isMissed(mail.sendAt, now);
}

/** A time Send later offers. */
export interface SendLaterPreset {
  readonly kind:
    | "this-afternoon"
    | "tomorrow-morning"
    | "tomorrow-afternoon"
    | "monday-morning";
  readonly at: Date;
}

const MORNING = 8;
const AFTERNOON = 13;

const at = (day: Date, hour: number, offsetDays = 0) => {
  const result = new Date(day);
  result.setDate(result.getDate() + offsetDays);
  result.setHours(hour, 0, 0, 0);
  return result;
};

/**
 * The times Send later offers on `now`'s day, in local time: this
 * afternoon (in the morning), tomorrow morning and afternoon, and Monday
 * morning on Fridays and Saturdays.
 */
export function sendLaterPresets(now: Date): SendLaterPreset[] {
  const presets: SendLaterPreset[] = [];
  if (now.getHours() < AFTERNOON - 1)
    presets.push({ kind: "this-afternoon", at: at(now, AFTERNOON) });
  presets.push(
    { kind: "tomorrow-morning", at: at(now, MORNING, 1) },
    { kind: "tomorrow-afternoon", at: at(now, AFTERNOON, 1) },
  );
  const weekday = now.getDay();
  if (weekday === 5 || weekday === 6)
    presets.push({
      kind: "monday-morning",
      at: at(now, MORNING, weekday === 5 ? 3 : 2),
    });
  return presets;
}

/** The earliest time a mail can be scheduled for: a minute from now. */
export function earliestSendAt(now: number): number {
  return now + 60_000;
}

/** A scheduled mail of an account. */
export interface ScheduledEntry {
  readonly accountId: AccountId;
  /** The account's Scheduled view. */
  readonly mailboxId: MailboxId;
  /** Who sends it: the server, or action0 from Drafts. */
  readonly scheduling: NonNullable<ProviderCapabilities["scheduling"]>;
  /** Its row, with `sendAt`. */
  readonly message: MessageSummary & { readonly sendAt: string };
}
