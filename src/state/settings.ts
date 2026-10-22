/**
 * App settings: how the app behaves in this browser. Saved with the UI
 * state in localStorage; signatures and other account settings live with
 * the provider instead.
 */

import type { IcsSubscription } from "../core/calendar";
import type { LanguageSetting } from "../i18n/locale";

/** Undo-send periods the settings offer, in seconds (0: send right away). */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;

/** Settings of this browser. */
export interface AppSettings {
  /** Two lines per message, or one (compact). */
  readonly density: "comfortable" | "compact";
  /** Where the cursor goes when the open message leaves the list (archive, delete, …). */
  readonly afterRemove: "below" | "above" | "list";
  /** When an opened message counts as read. */
  readonly markRead: "immediately" | "delay" | "manual";
  /** Remote images in HTML mail: ask, always load, or ask unless the sender is trusted. */
  readonly remoteImages: "ask" | "always" | "trusted";
  /** Senders whose remote images load right away (lower case), for `remoteImages: "trusted"`. */
  readonly trustedSenders: readonly string[];
  /** How long a sent mail can be taken back. */
  readonly undoSendSeconds: (typeof UNDO_SEND_CHOICES)[number];
  /** Desktop notifications for new mail (the browser must allow them too). */
  readonly notifications: boolean;
  /** One row per conversation instead of per message (where the account supports it). */
  readonly conversations: boolean;
  /** Interface language; "auto" follows the browser. */
  readonly language: LanguageSetting;
  /** iCal subscriptions (their URLs can be secret). */
  readonly icsCalendars: readonly IcsSubscription[];
  /** Calendars ticked or unticked by the user, by `<source>|<calendar>`. */
  readonly calendarChoices: Readonly<Record<string, boolean>>;
  /** The calendar view last used on larger screens. */
  readonly calendarView: "week" | "month" | "agenda";
}

/** The settings of a browser that never changed any. */
export const DEFAULT_SETTINGS: AppSettings = {
  density: "comfortable",
  afterRemove: "below",
  markRead: "delay",
  remoteImages: "ask",
  trustedSenders: [],
  undoSendSeconds: 30,
  notifications: true,
  conversations: false,
  language: "auto",
  icsCalendars: [],
  calendarChoices: {},
  calendarView: "week",
};

/** Most trusted senders kept (the oldest are dropped first). */
export const MAX_TRUSTED_SENDERS = 500;

const oneOf =
  <T extends string | number>(choices: readonly T[]) =>
  (value: unknown): value is T =>
    choices.includes(value as T);

const isDensity = oneOf(["comfortable", "compact"] as const);
const isAfterRemove = oneOf(["below", "above", "list"] as const);
const isMarkRead = oneOf(["immediately", "delay", "manual"] as const);
const isRemoteImages = oneOf(["ask", "always", "trusted"] as const);
const isUndoSend = oneOf(UNDO_SEND_CHOICES);
const isLanguage = oneOf(["auto", "en", "de"] as const);
const isCalendarView = oneOf(["week", "month", "agenda"] as const);

function parseSubscriptions(value: unknown): IcsSubscription[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): IcsSubscription[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, url, name, color } = entry as Record<string, unknown>;
    return typeof id === "string" &&
      typeof url === "string" &&
      typeof name === "string" &&
      typeof color === "string"
      ? [{ id, url, name, color }]
      : [];
  });
}

function parseChoices(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

/** Settings read from storage: every invalid or missing field gets its default. */
export function parseSettings(value: unknown): AppSettings {
  const raw = (
    typeof value === "object" && value !== null ? value : {}
  ) as Readonly<Record<string, unknown>>;
  const d = DEFAULT_SETTINGS;
  const trusted = Array.isArray(raw.trustedSenders)
    ? raw.trustedSenders.filter(
        (address): address is string =>
          typeof address === "string" && address.includes("@"),
      )
    : d.trustedSenders;
  return {
    density: isDensity(raw.density) ? raw.density : d.density,
    afterRemove: isAfterRemove(raw.afterRemove)
      ? raw.afterRemove
      : d.afterRemove,
    markRead: isMarkRead(raw.markRead) ? raw.markRead : d.markRead,
    remoteImages: isRemoteImages(raw.remoteImages)
      ? raw.remoteImages
      : d.remoteImages,
    trustedSenders: trusted.slice(-MAX_TRUSTED_SENDERS),
    undoSendSeconds: isUndoSend(raw.undoSendSeconds)
      ? raw.undoSendSeconds
      : d.undoSendSeconds,
    notifications:
      typeof raw.notifications === "boolean"
        ? raw.notifications
        : d.notifications,
    conversations:
      typeof raw.conversations === "boolean"
        ? raw.conversations
        : d.conversations,
    language: isLanguage(raw.language) ? raw.language : d.language,
    icsCalendars: parseSubscriptions(raw.icsCalendars),
    calendarChoices: parseChoices(raw.calendarChoices),
    calendarView: isCalendarView(raw.calendarView)
      ? raw.calendarView
      : d.calendarView,
  };
}

/** How long a message is on screen before it counts as read ("delay"). */
export const MARK_READ_DELAY_MS = 1500;

/** Delay before an opened message is marked read; `null`: never automatically. */
export function markReadDelayMs(
  setting: AppSettings["markRead"],
): number | null {
  if (setting === "immediately") return 0;
  return setting === "delay" ? MARK_READ_DELAY_MS : null;
}

/** Whether a mail's remote images load without asking. */
export function loadsRemoteImages(
  settings: Pick<AppSettings, "remoteImages" | "trustedSenders">,
  sender: string | undefined,
): boolean {
  if (settings.remoteImages === "always") return true;
  return (
    settings.remoteImages === "trusted" &&
    sender !== undefined &&
    settings.trustedSenders.includes(sender.toLowerCase())
  );
}
