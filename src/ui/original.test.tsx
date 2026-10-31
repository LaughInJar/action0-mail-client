import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCapabilities } from "../core/provider";
import { createDemoData } from "../providers/fake/demoData";
import { UI_STATE_KEY } from "../state/uiStore";
import { fakeDesktopPlatform } from "../test/desktopPlatform";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
/** The original's view (it loads on first use), once the message is in. */
async function originalView(name = "Original message") {
  const view = await screen.findByRole("dialog", { name }, { timeout: 5000 });
  await waitFor(() => {
    expect(within(view).queryByRole("status")).not.toBeInTheDocument();
  });
  return view;
}
const menuEntry = async (name: string | RegExp) =>
  within(await screen.findByRole("menu")).getByRole("menuitem", { name });

type User = ReturnType<typeof renderApp>["user"];

async function rightClick(user: User, target: Element) {
  await user.pointer({ keys: "[MouseRight]", target });
}

/** The summary's value for a label ("Message ID", …). */
function summaryValue(view: HTMLElement, label: string) {
  const term = within(view).getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Show original", () => {
  it("opens from the reader's ⋯ menu with a summary of the message", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await menuEntry("Show original (Ctrl+U)"));

    const view = await originalView();
    expect(view).toHaveTextContent("Your invoice 2026-1043");
    expect(window.location.hash).toContain("original=invoice");
    expect(summaryValue(view, "Message ID")).toBe("<invoice@demo.example>");
    expect(summaryValue(view, "From")).toBe("Shop <billing@shop.example>");
    expect(summaryValue(view, "Created at")).toContain(
      "Delivered after 5 seconds",
    );
    const checks = within(view).getByRole("region", { name: "Sender checks" });
    expect(
      within(checks)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "SPFPassfor shop.example",
      "DKIMPassfor shop.example",
      "DMARCPassfor shop.example",
    ]);
    const path = within(view).getByRole("region", { name: "Delivery path" });
    expect(within(path).getAllByRole("row")).toHaveLength(3);
    expect(within(view).getByRole("tab", { name: "Summary" })).toHaveFocus();
  });

  it("opens with Ctrl+U and closes with Esc and Back", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    const hash = window.location.hash;

    await user.keyboard("{Control>}u{/Control}");
    await originalView();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe(hash);

    await user.keyboard("{Meta>}u{/Meta}");
    await originalView();
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe(hash);
  });

  it("shows failed checks for mail in Spam, from the row's menu", async () => {
    const { user } = renderApp({ hash: demoHash("spam") });
    const row = await screen.findByRole("option", { name: /You have won/ });
    await rightClick(user, row);
    await user.click(await menuEntry("Show original (Ctrl+U)"));
    const view = await originalView();
    const checks = within(view).getByRole("region", { name: "Sender checks" });
    expect(checks).toHaveTextContent("DKIMFailfor spam.example");
    expect(checks).toHaveTextContent("SPFSoft failfor spam.example");
  });

  it("filters the headers and shows the source", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.keyboard("{Control>}u{/Control}");
    const view = await originalView();

    await user.click(within(view).getByRole("tab", { name: "Headers" }));
    const all = within(view).getByText(/^\d+ headers$/).textContent;
    await user.type(
      within(view).getByRole("searchbox", { name: "Filter headers" }),
      "received",
    );
    expect(
      within(view).getByText(`2 of ${all.split(" ")[0] ?? ""} headers`),
    ).toBeInTheDocument();
    expect(within(view).getAllByText("Received")).toHaveLength(2);

    // ←/→ move between the tabs.
    within(view).getByRole("tab", { name: "Headers" }).focus();
    await user.keyboard("{ArrowRight}");
    const tab = within(view).getByRole("tab", { name: "Source" });
    expect(tab).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(
      within(view).getByLabelText("Source of the message"),
    ).toHaveTextContent(/Content-Type: application\/pdf/);
  });

  it("leaves big encoded parts out of the shown source, but not out of Copy and Download", async () => {
    const desktop = fakeDesktopPlatform();
    const big = new Uint8Array(150_000).fill(65);
    const { user } = renderApp({
      hash: demoHash("inbox", "invoice"),
      platform: desktop.platform,
      data: () => {
        const data = createDemoData(TEST_NOW);
        return {
          ...data,
          attachments: new Map([
            ...(data.attachments ?? []),
            ["invoice/invoice-pdf", new Blob([big])],
          ]),
        };
      },
    });
    await subject("Your invoice 2026-1043");
    await user.keyboard("{Control>}u{/Control}");
    const view = await originalView();
    await user.click(within(view).getByRole("tab", { name: "Source" }));
    const source = within(view).getByLabelText("Source of the message");
    expect(source).toHaveTextContent(
      "invoice-2026-1043.pdf (146 KB) isn’t shown here. Download or Copy has the whole message.",
    );
    expect(source.textContent.length).toBeLessThan(10_000);

    await user.click(within(view).getByRole("button", { name: "Copy" }));
    expect(await toastText("Copied the original")).toBeInTheDocument();
    const copied = await navigator.clipboard.readText();
    expect(copied.length).toBeGreaterThan(200_000);

    await user.click(within(view).getByRole("button", { name: "Download" }));
    expect(desktop.platform.saveFile).toHaveBeenCalledWith(
      expect.any(Blob),
      "Your invoice 2026-1043.eml",
    );
    const [blob] = desktop.platform.saveFile.mock.calls[0] as unknown as [Blob];
    expect(blob.size).toBeGreaterThan(200_000);
  });

  it("shows the message of the menu or the cursor inside a conversation", async () => {
    window.localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        state: { settings: { conversations: true } },
        version: 1,
      }),
    );
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject(/Trip to Lake Como/);
    const messages = screen.getByRole("list", { name: "Messages" });

    // The menu of the oldest message: that one.
    await rightClick(
      user,
      within(messages).getByRole("button", { name: /^Anna Berger.*Shall we/ }),
    );
    await user.click(await menuEntry("Show original (Ctrl+U)"));
    expect(summaryValue(await originalView(), "Message ID")).toBe(
      "<trip-1@demo.example>",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Ctrl+U: the message at the cursor (the newest).
    await user.keyboard("{Control>}u{/Control}");
    expect(summaryValue(await originalView(), "Message ID")).toBe(
      "<trip-3@demo.example>",
    );
  });

  it("is in German too", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-AT", "de"]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-AT");
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.keyboard("{Control>}u{/Control}");
    const view = await originalView("Originalnachricht");
    expect(summaryValue(view, "Erstellt am")).toContain(
      "Zugestellt nach 5 Sekunden",
    );
    expect(
      within(view).getByRole("region", { name: "Absenderprüfungen" }),
    ).toHaveTextContent("SPFBestandenfür shop.example");
    expect(within(view).getByRole("tab", { name: "Quelltext" })).toBeVisible();
  });

  it("isn't offered when the account can't deliver the source", async () => {
    const { user, services } = renderApp({
      hash: demoHash("inbox", "invoice"),
    });
    const provider = services.registry.list()[0]?.provider;
    if (!provider) throw new Error("No provider");
    const capabilities: ProviderCapabilities = {
      ...provider.capabilities,
      rawSource: false,
    };
    Object.defineProperty(provider, "capabilities", { value: capabilities });
    await subject("Your invoice 2026-1043");
    // ⋯ has only what never gets a button of its own.
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      within(screen.getByRole("menu", { name: "More actions" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Filter mail like this"]);
    await user.keyboard("{Escape}");
    await rightClick(
      user,
      await screen.findByRole("option", { name: /Your invoice 2026-1043/ }),
    );
    expect(
      within(await screen.findByRole("menu")).queryByRole("menuitem", {
        name: /Show original/,
      }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}u{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.hash).not.toContain("original=");
  });
});
