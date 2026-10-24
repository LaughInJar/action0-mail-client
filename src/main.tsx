import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { readConfig } from "./app/config";
import { IcsCalendarProvider } from "./providers/ical/IcsCalendarProvider";
import { DEMO_ACCOUNT, DEMO_WORK_ACCOUNT } from "./providers/fake/module";
import {
  createAppServices,
  createDefaultModules,
  createDefaultSetups,
} from "./app/services";
import { messages } from "./i18n/messages";
import { getLocalStorage, getSessionStorage } from "./lib/storage";
import "./index.css";

/** True inside the desktop or Android app (Tauri). */
const inApp = "__TAURI_INTERNALS__" in window;

/** The page the browser shows after signing in, in the interface's language. */
const signedInPage = () =>
  messages[document.documentElement.lang.startsWith("de") ? "de" : "en"].desktop
    .signedIn;

const config = readConfig();
const sessionStorage = getSessionStorage();
const localStorage = getLocalStorage();
// The app's own sign-in, networking and integration.
const native = inApp
  ? await import("./platform/native").then((module) =>
      module.startNative(signedInPage),
    )
  : undefined;
const nativeServices = native && {
  native: { bridge: native.auth, accounts: native.accounts },
  fetch: native.fetch,
  android: native.platform.kind === "android",
};
const services = createAppServices({
  modules: createDefaultModules(
    config,
    sessionStorage,
    localStorage,
    nativeServices,
  ),
  createSetups: createDefaultSetups(
    config,
    sessionStorage,
    localStorage,
    nativeServices,
  ),
  localStorage,
  sessionStorage,
  version: config.version,
  ...(native
    ? {
        platform: native.platform,
        icsFactory: (subscription) =>
          new IcsCalendarProvider(subscription, { fetch: native.fetch }),
      }
    : {}),
});

// `?demo` in the URL connects the demo accounts that aren't yet (no
// sign-in involved).
const url = new URL(window.location.href);
if (url.searchParams.has("demo")) {
  url.searchParams.delete("demo");
  window.history.replaceState(window.history.state, "", url);
  const first = services.registry.get(DEMO_ACCOUNT.id)
    ? Promise.resolve()
    : services.registry.add("demo");
  void first.then(() => {
    services.registry.addKnown(DEMO_WORK_ACCOUNT);
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
