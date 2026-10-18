import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { readConfig } from "./app/config";
import {
  createAppServices,
  createDefaultModules,
  createDefaultSetups,
} from "./app/services";
import { getLocalStorage, getSessionStorage } from "./lib/storage";
import "./index.css";

const config = readConfig();
const sessionStorage = getSessionStorage();
const localStorage = getLocalStorage();
const services = createAppServices({
  modules: createDefaultModules(config, sessionStorage, localStorage),
  createSetups: createDefaultSetups(config, sessionStorage, localStorage),
  localStorage,
  sessionStorage,
  version: config.version,
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
