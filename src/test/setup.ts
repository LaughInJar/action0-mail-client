import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Layout APIs that jsdom doesn't implement. (Node-environment tests have no Element.)
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollBy = () => undefined;
  // ProseMirror (the composer's editor) measures the selection.
  const noRects = () => Object.assign([], { item: () => null }) as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
