import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onTestFinished } from "vitest";
import { saveAccounts } from "../accounts/accountStorage";
import type { ProviderModule } from "../accounts/types";
import { App } from "../app/App";
import { createAppServices } from "../app/services";
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
}

/** Renders the whole app against the in-memory demo provider. */
export function renderApp({
  viewport = "wide",
  signedIn = true,
  hash,
  data = () => createDemoData(TEST_NOW),
  modules,
}: RenderAppOptions = {}) {
  mockViewport(viewport);
  if (hash !== undefined) window.history.replaceState(null, "", `/${hash}`);
  if (signedIn) saveAccounts(window.localStorage, [DEMO_ACCOUNT]);

  const services = createAppServices({
    modules: modules ?? [createDemoModule({ latencyMs: 0, data })],
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
