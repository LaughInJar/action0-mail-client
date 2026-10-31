import { describe, expect, it } from "vitest";
import {
  cacheName,
  handlingOf,
  isMessage,
  readShare,
  SHARE_PATH,
} from "./logic";

const ORIGIN = "https://mail.example.com";
const files = new Set(["/index.html", "/assets/main-abc.js", "/theme.js"]);
const request = (url: string, method = "GET", mode = "cors") => ({
  url,
  method,
  mode,
});

describe("the service worker's requests", () => {
  it("answers the app's own files and pages, and leaves everything else alone", () => {
    const handling = (url: string, method?: string, mode?: string) =>
      handlingOf(request(url, method, mode), ORIGIN, files);
    expect(handling(`${ORIGIN}/assets/main-abc.js`)).toBe("cached");
    expect(handling(`${ORIGIN}/theme.js?v=2`)).toBe("cached");
    expect(handling(`${ORIGIN}/`, "GET", "navigate")).toBe("page");
    expect(handling(`${ORIGIN}/?mailto=x`, "GET", "navigate")).toBe("page");
    expect(handling(`${ORIGIN}${SHARE_PATH}`, "POST", "navigate")).toBe(
      "share",
    );
    // Microsoft's sign-in page, other files, APIs and other sites.
    expect(handling(`${ORIGIN}/redirect.html`, "GET", "navigate")).toBe(
      "network",
    );
    expect(handling(`${ORIGIN}/unknown.js`)).toBe("network");
    expect(handling(`${ORIGIN}/assets/main-abc.js`, "POST")).toBe("network");
    expect(
      handling("https://gmail.googleapis.com/gmail/v1/users/me/messages"),
    ).toBe("network");
    expect(handling("https://graph.microsoft.com/v1.0/me")).toBe("network");
  });

  it("names its caches by version", () => {
    expect(cacheName("1.2.3-abc")).toBe("a0-shell-1.2.3-abc");
  });
});

describe("shared content", () => {
  it("reads title, text, link and files, leaving out empty ones", () => {
    const form = new FormData();
    form.set("title", " Trip ");
    form.set("text", "");
    form.set("url", "https://example.org/x");
    form.append(
      "files",
      new File(["pdf"], "plan.pdf", { type: "application/pdf" }),
    );
    form.append("files", new File([], ""));
    const shared = readShare(form);
    expect(shared).toMatchObject({
      title: "Trip",
      url: "https://example.org/x",
    });
    expect(shared.text).toBeUndefined();
    expect(shared.files.map((file) => file.name)).toEqual(["plan.pdf"]);
  });

  it("tells messages apart by type", () => {
    expect(isMessage({ type: "skip-waiting" }, "skip-waiting")).toBe(true);
    expect(isMessage({ type: "share", id: "1" }, "skip-waiting")).toBe(false);
    expect(isMessage(null, "share")).toBe(false);
  });
});
