import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Layout APIs that jsdom doesn't implement. (Node-environment tests have no Element.)
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollBy = () => undefined;
}

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
