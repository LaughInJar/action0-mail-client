import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { objectUrlBlobs } from "./objectUrls";

// Layout APIs that jsdom doesn't implement. (Node-environment tests have no Element.)
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollBy = () => undefined;
  // ProseMirror (the composer's editor) measures the selection.
  const noRects = () => Object.assign([], { item: () => null }) as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // Object URLs for files (jsdom has none); `objectUrlBlobs` maps them back.
  let nextUrl = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${String(++nextUrl)}`;
    if (blob instanceof Blob) objectUrlBlobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    objectUrlBlobs.delete(url);
  };
}

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
