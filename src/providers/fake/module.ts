import type { ProviderModule } from "../../accounts/types";
import type { CalendarAccess } from "../../core/calendar";
import { StaticAuthSession } from "../../auth/staticSession";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import { createDemoCalendar } from "./demoCalendar";
import { createDemoArrival, createDemoData, DEMO_EMAIL } from "./demoData";
import {
  FakeCalendarProvider,
  type FakeCalendarData,
} from "./FakeCalendarProvider";
import { FakeMailProvider, type FakeMailData } from "./FakeMailProvider";
import { createWorkArrival, createWorkDemoData, WORK_EMAIL } from "./demoWork";

/** The demo account. */
export const DEMO_ACCOUNT: Account = {
  id: asAccountId(`demo:${DEMO_EMAIL}`),
  type: "demo",
  email: DEMO_EMAIL,
};

/**
 * The second demo account (Outlook-like folders), so All inboxes can be
 * tried. It needs no sign-in: added with `AccountRegistry.addKnown`.
 */
export const DEMO_WORK_ACCOUNT: Account = {
  id: asAccountId(`demo:${WORK_EMAIL}`),
  type: "demo",
  email: WORK_EMAIL,
};

/** Options of {@link createDemoModule}. */
export interface DemoModuleOptions {
  /** Simulated latency per call, so loading states are visible. */
  readonly latencyMs?: number;
  /** Replaces the generated demo content (used by tests). */
  readonly data?: () => FakeMailData;
  /** Replaces the second demo account's content (used by tests). */
  readonly workData?: () => FakeMailData;
  /** A new message arrives this often (ms); `false` for none. */
  readonly arrivalEveryMs?: number | false;
  /** Clock for arrivals (tests). */
  readonly now?: () => number;
  /** Replaces the demo calendar (used by tests). */
  readonly calendar?: () => FakeCalendarData;
  /** Calendar access as if the account hadn't allowed it yet (tests). */
  readonly calendarAccess?: CalendarAccess;
  /** Whether guests hear about changes only when asked (Google-like, default) or always (tests). */
  readonly guestNotices?: "ask" | "always";
  /** Reminders kept by the calendar, like Outlook's (tests). */
  readonly syncedReminders?: boolean;
}

/** Provider module of the demo account: in-memory data, no sign-in. */
export function createDemoModule({
  latencyMs = 150,
  data = createDemoData,
  workData = createWorkDemoData,
  arrivalEveryMs = 2 * 60_000,
  now,
  calendar = () => createDemoCalendar(now?.() ?? Date.now()),
  calendarAccess = "granted",
  guestNotices = "ask",
  syncedReminders = false,
}: DemoModuleOptions = {}): ProviderModule {
  return {
    type: "demo",
    label: "Demo account",
    connect: () =>
      Promise.resolve({ account: DEMO_ACCOUNT, auth: new StaticAuthSession() }),
    restore: () => new StaticAuthSession(),
    createCalendar: (account) => {
      const work = account.email === WORK_EMAIL;
      return new FakeCalendarProvider(
        work
          ? {
              calendars: [],
              events: [],
              me: { address: WORK_EMAIL },
              now: now?.() ?? Date.now(),
            }
          : calendar(),
        {
          latencyMs,
          access: calendarAccess,
          guestNotices,
          syncedReminders,
        },
      );
    },
    createProvider: (account) => {
      const work = account.email === WORK_EMAIL;
      return new FakeMailProvider(work ? workData() : data(), {
        latencyMs,
        ...(now ? { now } : {}),
        ...(arrivalEveryMs === false
          ? {}
          : {
              arrivals: work
                ? // Less often than the first account, so both show up.
                  { everyMs: arrivalEveryMs * 1.5, create: createWorkArrival }
                : { everyMs: arrivalEveryMs, create: createDemoArrival },
            }),
      });
    },
  };
}
