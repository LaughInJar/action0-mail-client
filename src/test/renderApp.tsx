import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onTestFinished } from "vitest";
import { saveAccounts } from "../accounts/accountStorage";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import { App } from "../app/App";
import type { AiBackend } from "../ai/backend";
import { createAppServices } from "../app/services";
import type { CalendarAccess } from "../core/calendar";
import type { IcsFactory } from "../data/calendar";
import type { Platform } from "../platform/types";
import { createDemoCalendar } from "../providers/fake/demoCalendar";
import { createDemoData } from "../providers/fake/demoData";
import type { FakeCalendarData } from "../providers/fake/FakeCalendarProvider";
import type { FakeMailData } from "../providers/fake/FakeMailProvider";
import { createWorkDemoData } from "../providers/fake/demoWork";
import {
  createDemoModule,
  DEMO_ACCOUNT,
  DEMO_WORK_ACCOUNT,
} from "../providers/fake/module";
import { UI_STATE_KEY } from "../state/uiStore";
import { mockViewport, type Viewport } from "./viewport";

/** Fixed "now" for test data. */
export const TEST_NOW = Date.parse("2026-10-18T12:00:00Z");

/** Options of {@link renderApp}. */
export interface RenderAppOptions {
  readonly viewport?: Viewport;
  /** Start with the demo account connected (as if restored from a previous visit). */
  readonly signedIn?: boolean;
  /** Initial URL hash, e.g. `#/demo%3Ademo%40example.com/inbox`. */
  readonly hash?: string;
  readonly data?: () => FakeMailData;
  readonly modules?: readonly ProviderModule[];
  /** Runtime provider setups (e.g. a Google client ID entered in the wizard). */
  readonly setups?: (registry: AccountRegistry) => readonly ProviderSetup[];
  /** The demo calendar's access (default: granted). */
  readonly calendarAccess?: CalendarAccess;
  /** Creates iCal subscriptions' calendars (default: the real one, with `fetch`). */
  readonly icsFactory?: IcsFactory;
  /** How the demo calendar tells guests (default: asks, like Google). */
  readonly guestNotices?: "ask" | "always";
  /** The platform (default: the web app). */
  readonly platform?: Platform;
  /** Replaces the demo calendar (default: events around TEST_NOW). */
  readonly calendar?: () => FakeCalendarData;
  /** The demo calendar keeps reminders like Outlook. */
  readonly syncedReminders?: boolean;
  /**
   * Event reminders on (default: off, so the demo's repeating events can't
   * remind in tests that don't expect it, whatever the time of day).
   */
  readonly reminders?: boolean;
  /** Also the second demo account (Outlook-like folders), as if restored. */
  readonly workAccount?: boolean;
  readonly workData?: () => FakeMailData;
  /** The AI backend (default: the browser's). */
  readonly ai?: AiBackend;
}

/** Renders the whole app against the in-memory demo provider. */
export function renderApp({
  viewport = "wide",
  signedIn = true,
  hash,
  data = () => createDemoData(TEST_NOW),
  modules,
  setups,
  calendarAccess = "granted",
  icsFactory,
  guestNotices = "ask",
  platform,
  calendar = () => createDemoCalendar(TEST_NOW),
  syncedReminders = false,
  reminders = false,
  workAccount = false,
  workData = () => createWorkDemoData(TEST_NOW),
  ai,
}: RenderAppOptions = {}) {
  mockViewport(viewport);
  if (!reminders) turnRemindersOff(window.localStorage);
  if (hash !== undefined) window.history.replaceState(null, "", `/${hash}`);
  if (signedIn)
    saveAccounts(window.localStorage, [
      DEMO_ACCOUNT,
      ...(workAccount ? [DEMO_WORK_ACCOUNT] : []),
    ]);

  const services = createAppServices({
    modules: modules ?? [
      createDemoModule({
        latencyMs: 0,
        data,
        workData,
        arrivalEveryMs: false,
        // Events around TEST_NOW (week of Monday 2026-10-12).
        calendar,
        calendarAccess,
        guestNotices,
        syncedReminders,
      }),
    ],
    ...(setups ? { createSetups: setups } : {}),
    ...(icsFactory ? { icsFactory } : {}),
    ...(platform ? { platform } : {}),
    ...(ai ? { ai } : {}),
    localStorage: window.localStorage,
    // No query persistence in UI tests: every test starts cold.
    sessionStorage: undefined,
    version: "test",
  });
  onTestFinished(() => {
    services.router.dispose();
    services.queryClient.clear();
  });

  const user = userEvent.setup();
  return { ...render(<App services={services} />), services, user };
}

/** Hash route of a demo mailbox (and message). */
export function demoHash(mailboxId: string, messageId?: string): string {
  const account = encodeURIComponent(DEMO_ACCOUNT.id);
  return `#/${account}/${mailboxId}${messageId === undefined ? "" : `/${messageId}`}`;
}

/** Hash route of All inboxes, with a message of an account open (or none). */
export function unifiedHash(
  accountId = DEMO_ACCOUNT.id,
  inboxId = "inbox",
  messageId?: string,
): string {
  const account = encodeURIComponent(accountId);
  return `#/all/${account}/${inboxId}${messageId === undefined ? "" : `/${messageId}`}`;
}

/** Keeps any settings stored for the test, with event reminders off. */
function turnRemindersOff(storage: Storage) {
  const stored = JSON.parse(storage.getItem(UI_STATE_KEY) ?? "null") as {
    state?: { settings?: object };
  } | null;
  storage.setItem(
    UI_STATE_KEY,
    JSON.stringify({
      ...stored,
      state: {
        ...stored?.state,
        settings: { ...stored?.state?.settings, eventReminders: false },
      },
      version: 1,
    }),
  );
}
