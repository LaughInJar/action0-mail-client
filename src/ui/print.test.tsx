import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });

interface Printed {
  readonly text: string;
  readonly mails: readonly string[];
  readonly title: string;
}

/** Makes `window.print` record the print layout as it is when the dialog opens. */
function recordPrints(): Printed[] {
  const printed: Printed[] = [];
  vi.spyOn(window, "print").mockImplementation(() => {
    const root = document.getElementById("print-root");
    printed.push({
      text: root?.textContent ?? "",
      mails: [...(root?.querySelectorAll("[data-mail]") ?? [])].map(
        (host) => host.shadowRoot?.innerHTML ?? "",
      ),
      title: document.title,
    });
    window.dispatchEvent(new Event("afterprint"));
  });
  return printed;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printing", () => {
  it("prints the open message with Ctrl+P: headers, text, attachments' names", async () => {
    const printed = recordPrints();
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.keyboard("{Control>}p{/Control}");
    await waitFor(() => {
      expect(printed).toHaveLength(1);
    });
    const [page] = printed;
    expect(page?.title).toBe("Your invoice 2026-1043");
    expect(page?.text).toMatch(/From.*billing@shop\.example/);
    expect(page?.text).toMatch(/Attachments: invoice-2026-1043\.pdf/);
    // Done: the layout is gone again.
    await waitFor(() => {
      expect(document.getElementById("print-root")).toBeNull();
    });
  });

  it("leaves out remote images unless they were loaded for the message", async () => {
    const printed = recordPrints();
    const { user } = renderApp({ hash: demoHash("inbox", "newsletter") });
    await subject("This week in web development");
    await user.keyboard("{Control>}p{/Control}");
    await waitFor(() => {
      expect(printed).toHaveLength(1);
    });
    expect(printed[0]?.mails[0]).not.toMatch(/images\.example\.com/);
    expect(printed[0]?.mails[0]).toMatch(/Weekly Digest logo/);

    await user.click(screen.getByRole("button", { name: "Load images" }));
    await user.keyboard("{Control>}p{/Control}");
    await waitFor(() => {
      expect(printed).toHaveLength(2);
    });
    expect(printed[1]?.mails[0]).toMatch(
      /src="https:\/\/images\.example\.com\/logo\.png"/,
    );
  });

  it("prints the whole conversation in conversation view, one message from its menu", async () => {
    const printed = recordPrints();
    const { user, services } = renderApp({ hash: demoHash("inbox") });
    await subject("Welcome to the demo");
    act(() => {
      services.uiStore.getState().updateSettings({ conversations: true });
    });
    await user.click(await screen.findByRole("option", { name: /Lake Como/ }));
    await subject(/^Trip to Lake Como/);
    await user.keyboard("{Meta>}p{/Meta}");
    await waitFor(() => {
      expect(printed).toHaveLength(1);
    });
    expect(printed[0]?.text.match(/From/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );

    const header = screen
      .getAllByRole("button", { name: "Anna Berger" })[0]!
      .closest("header")!;
    await user.pointer({ keys: "[MouseRight]", target: header });
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Print (Ctrl+P)" }),
    );
    await waitFor(() => {
      expect(printed).toHaveLength(2);
    });
    expect(printed[1]?.text.match(/From/g)).toHaveLength(1);
  });

  it("offers Print in the reader's More menu", async () => {
    recordPrints();
    const { user } = renderApp({ hash: demoHash("inbox", "welcome") });
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: /^More/ }));
    expect(
      await screen.findByRole("menuitem", { name: "Print (Ctrl+P)" }),
    ).toBeInTheDocument();
  });
});
