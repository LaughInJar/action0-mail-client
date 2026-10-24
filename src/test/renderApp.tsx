import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onTestFinished } from "vitest";
import { saveAccounts } from "../accounts/accountStorage";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import { App } from "../app/App";
import { createAppServices } from "../app/services";
import type { CalendarAccess } from "../core/calendar";
import type { IcsFactory } from "../data/calendar";
import { createDemoCalendar } from "../providers/fake/demoCalendar";
import { createDemoData } from "../providers/fake/demoData";
import type { FakeMailData } from "../providers/fake/FakeMailProvider";
import { createDemoModule, DEMO_ACCOUNT } from "../providers/fake/module";
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
}: RenderAppOptions = {}) {
  mockViewport(viewport);
  if (hash !== undefined) window.history.replaceState(null, "", `/${hash}`);
  if (signedIn) saveAccounts(window.localStorage, [DEMO_ACCOUNT]);

  const services = createAppServices({
    modules: modules ?? [
      createDemoModule({
        latencyMs: 0,
        data,
        arrivalEveryMs: false,
        // Events around TEST_NOW (week of Monday 2026-10-12).
        calendar: () => createDemoCalendar(TEST_NOW),
        calendarAccess,
        guestNotices,
      }),
    ],
    ...(setups ? { createSetups: setups } : {}),
    ...(icsFactory ? { icsFactory } : {}),
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
