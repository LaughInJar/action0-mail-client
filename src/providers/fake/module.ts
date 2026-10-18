import type { ProviderModule } from "../../accounts/types";
import { StaticAuthSession } from "../../auth/staticSession";
import { asAccountId } from "../../core/ids";
import type { Account } from "../../core/model";
import { createDemoArrival, createDemoData, DEMO_EMAIL } from "./demoData";
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
}

/** Provider module of the demo account: in-memory data, no sign-in. */
export function createDemoModule({
  latencyMs = 150,
  data = createDemoData,
  arrivalEveryMs = 2 * 60_000,
  now,
}: DemoModuleOptions = {}): ProviderModule {
  return {
    type: "demo",
    label: "Demo account",
    connect: () =>
      Promise.resolve({ account: DEMO_ACCOUNT, auth: new StaticAuthSession() }),
    restore: () => new StaticAuthSession(),
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
