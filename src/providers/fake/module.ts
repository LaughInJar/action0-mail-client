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

/** The demo account. */
export const DEMO_ACCOUNT: Account = {
  id: asAccountId(`demo:${DEMO_EMAIL}`),
  type: "demo",
  email: DEMO_EMAIL,
};

/** Options of {@link createDemoModule}. */
export interface DemoModuleOptions {
  /** Simulated latency per call, so loading states are visible. */
  readonly latencyMs?: number;
  /** Replaces the generated demo content (used by tests). */
  readonly data?: () => FakeMailData;
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
}

/** Provider module of the demo account: in-memory data, no sign-in. */
export function createDemoModule({
  latencyMs = 150,
  data = createDemoData,
  arrivalEveryMs = 2 * 60_000,
  now,
  calendar = () => createDemoCalendar(now?.() ?? Date.now()),
  calendarAccess = "granted",
  guestNotices = "ask",
}: DemoModuleOptions = {}): ProviderModule {
  return {
    type: "demo",
    label: "Demo account",
    connect: () =>
      Promise.resolve({ account: DEMO_ACCOUNT, auth: new StaticAuthSession() }),
    restore: () => new StaticAuthSession(),
    createCalendar: () =>
      new FakeCalendarProvider(calendar(), {
        latencyMs,
        access: calendarAccess,
        guestNotices,
      }),
    createProvider: () =>
      new FakeMailProvider(data(), {
        latencyMs,
        ...(now ? { now } : {}),
        ...(arrivalEveryMs === false
          ? {}
          : {
              arrivals: { everyMs: arrivalEveryMs, create: createDemoArrival },
            }),
      }),
  };
}
