import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { readConfig } from "./app/config";
import { IcsCalendarProvider } from "./providers/ical/IcsCalendarProvider";
import {
  createAppServices,
  createDefaultModules,
  createDefaultSetups,
} from "./app/services";
import { messages } from "./i18n/messages";
import { getLocalStorage, getSessionStorage } from "./lib/storage";
import "./index.css";

/** True inside the desktop app (Tauri). */
const inDesktopApp = "__TAURI_INTERNALS__" in window;

/** The page the browser shows after signing in, in the interface's language. */
const signedInPage = () =>
  messages[document.documentElement.lang.startsWith("de") ? "de" : "en"].desktop
    .signedIn;

const config = readConfig();
const sessionStorage = getSessionStorage();
const localStorage = getLocalStorage();
// The desktop app's own sign-in, networking and integration.
const desktop = inDesktopApp
  ? await import("./platform/desktop").then((module) =>
      module.startDesktop(signedInPage),
    )
  : undefined;
const desktopServices = desktop && {
  native: { bridge: desktop.auth, accounts: desktop.accounts },
  fetch: desktop.fetch,
};
const services = createAppServices({
  modules: createDefaultModules(
    config,
    sessionStorage,
    localStorage,
    desktopServices,
  ),
  createSetups: createDefaultSetups(
    config,
    sessionStorage,
    localStorage,
    desktopServices,
  ),
  localStorage,
  sessionStorage,
  version: config.version,
  ...(desktop
    ? {
        platform: desktop.platform,
        icsFactory: (subscription) =>
          new IcsCalendarProvider(subscription, { fetch: desktop.fetch }),
      }
    : {}),
});

// `?demo` in the URL connects the demo account (no sign-in involved).
const url = new URL(window.location.href);
if (url.searchParams.has("demo")) {
  url.searchParams.delete("demo");
  window.history.replaceState(window.history.state, "", url);
  if (
    !services.registry.list().some((handle) => handle.account.type === "demo")
  ) {
    void services.registry.add("demo");
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
