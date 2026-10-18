import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objectUrlBlobs } from "../test/objectUrls";
import { demoHash, renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
// The editor loads on first use; on a cold CI machine that takes a moment.
const composer = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const SAVE_WAIT = { timeout: 4000 };
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Records `<a download>` clicks instead of navigating (jsdom can't). */
function captureDownloads() {
  const downloads: { name: string; type: string | undefined }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({
      name: this.download,
      type: objectUrlBlobs.get(this.href)?.type,
    });
  });
  return downloads;
}

/** A drag event carrying files (jsdom has no DataTransfer). */
function fileEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
  });
  return event;
}

const fileInput = () =>
  document.querySelector<HTMLInputElement>(
    '[data-own-keys] input[type="file"]',
  );
const chips = () =>
  within(screen.getByRole("list", { name: "Attachments" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("received attachments", () => {
  it("opens images in the viewer, with ← / → and Esc", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "photos") });
    await subject("Photos from the hike");
    await user.click(screen.getByRole("button", { name: "Open summit.svg" }));
    const viewer = await screen.findByRole("dialog", { name: "summit.svg" });
    expect(within(viewer).getByText("1 of 2")).toBeInTheDocument();
    const image = await within(viewer).findByRole("img", {
      name: "summit.svg",
    });
    expect(objectUrlBlobs.get(image.getAttribute("src") ?? "")?.type).toBe(
      "image/svg+xml",
    );

    await user.keyboard("{ArrowRight}");
    expect(
      await screen.findByRole("dialog", { name: "sunset.svg" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("only downloads other files, never shown as a page", async () => {
    const downloads = captureDownloads();
    const open = vi.spyOn(window, "open");
    const { user } = renderApp({ hash: demoHash("inbox", "photos") });
    await subject("Photos from the hike");
    // An HTML file has no Open, just Download.
    await user.click(
      screen.getByRole("button", { name: "Download route.html" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Download summit.svg" }),
    );
    await waitFor(() => {
      expect(downloads).toEqual([
        { name: "route.html", type: "application/octet-stream" },
        { name: "summit.svg", type: "application/octet-stream" },
      ]);
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens PDFs in a new tab, always as PDF", async () => {
    const tab = { opener: window, location: { href: "" }, close: vi.fn() };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(tab as unknown as Window);
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.click(
      screen.getByRole("button", { name: "Open invoice-2026-1043.pdf" }),
    );
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    await waitFor(() => {
      expect(tab.location.href).toMatch(/^blob:/);
    });
    expect(objectUrlBlobs.get(tab.location.href)?.type).toBe("application/pdf");
  });
});

describe("attaching files", () => {
  it("adds files with the paperclip and removes them again", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    await composer("New message");
    const input = fileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    await user.upload(input, [
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      new File(["%PDF"], "plan.pdf", { type: "application/pdf" }),
    ]);
    expect(chips()).toEqual(["notes.txt5 B", "plan.pdf4 B"]);
    await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(chips()).toEqual(["plan.pdf4 B"]);
  });

  it("refuses files that would exceed the limit, and says why", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");
    const huge = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
    const input = fileInput();
    if (!input) throw new Error("no file input");
    await user.upload(input, huge);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "With this file the mail would carry 26 MB of attachments; the limit is 25 MB.",
    );
    expect(
      within(dialog).queryByRole("list", { name: "Attachments" }),
    ).not.toBeInTheDocument();
  });

  it("attaches files dropped on the composer", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");
    const file = new File(["data"], "data.csv", { type: "text/csv" });
    act(() => {
      dialog.dispatchEvent(fileEvent("dragenter", [file]));
    });
    expect(
      within(dialog).getByText(/Drop files to attach/),
    ).toBeInTheDocument();
    act(() => {
      dialog.dispatchEvent(fileEvent("drop", [file]));
    });
    expect(chips()).toEqual(["data.csv4 B"]);
    expect(within(dialog).queryByText(/Drop files to attach/)).toBeNull();
  });

  it("starts a new mail with files dropped anywhere", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const file = new File(["data"], "report.txt", { type: "text/plain" });
    act(() => {
      document.body.dispatchEvent(fileEvent("dragenter", [file]));
    });
    expect(
      screen.getByText("Drop to start a new mail with these files"),
    ).toBeInTheDocument();
    act(() => {
      document.body.dispatchEvent(fileEvent("drop", [file]));
    });
    await composer("New message");
    expect(chips()).toEqual(["report.txt4 B"]);
  });

  it("pastes pictures into the text inline, and they survive the draft", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    await composer("New message");
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Pic");
    const body = document.getElementById("composer-body");
    if (!body) throw new Error("no editor");
    const picture = new File(["<svg/>"], "shot.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [picture], types: ["Files"], getData: () => "" },
    });
    act(() => {
      body.dispatchEvent(paste);
    });
    const inline = body.querySelector("img[data-cid]");
    expect(inline).not.toBeNull();
    expect(inline?.getAttribute("src")).toMatch(/^blob:/);
    // Inline pictures aren't listed as attachments.
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();

    await screen.findByText("Saved", {}, SAVE_WAIT);
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("treeitem", { name: /^Drafts/ }));
    await user.click(await screen.findByRole("option", { name: /Pic/ }));
    await composer("Pic");
    await waitFor(() => {
      expect(
        document
          .querySelector("#composer-body img[data-cid]")
          ?.getAttribute("src"),
      ).toMatch(/^blob:/);
    }, SAVE_WAIT);
  });
});
