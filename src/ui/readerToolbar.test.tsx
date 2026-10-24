import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });

/** jsdom has no layout: the reader toolbar gets `width`, buttons 36px. */
function layOut(width: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("role") === "group" ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("aria-hidden") === "true" ? 36 : 0;
    },
  );
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #callback: () => void;
      constructor(callback: () => void) {
        this.#callback = callback;
        observers.push(callback);
      }
      observe() {
        this.#callback();
      }
      disconnect() {
        return undefined;
      }
    },
  );
  return observers;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const toolbar = () => screen.getByRole("group", { name: "Message actions" });
const buttons = () =>
  within(toolbar())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

describe("the reader toolbar", () => {
  it("shows every button when there's room", async () => {
    layOut(800);
    renderApp();
    await subject("Welcome to the demo");
    expect(buttons()).not.toContain("More actions");
    expect(buttons()).toContain("Forward (f)");
  });

  it("puts what doesn't fit into ⋯, by priority, and runs it from there", async () => {
    layOut(300);
    const { user } = renderApp();
    await subject("Welcome to the demo");
    expect(buttons()).toEqual([
      "Reply (r)",
      "Archive (a)",
      "Move to Trash (Delete)",
      "Move to… (v)",
      "Unstar (s)",
      "Mark as read (Shift+I)",
      "More actions",
    ]);
    await user.click(
      within(toolbar()).getByRole("button", { name: "More actions" }),
    );
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Reply all (Shift+R)",
      "Forward (f)",
      "Report spam (Shift+S)",
      "Labels… (l)",
    ]);
    // The first item has focus; the arrow keys move it, Esc closes.
    await waitFor(() => {
      expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus();
    });
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(
      await screen.findByRole("dialog", { name: /Labels/ }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(
      within(toolbar()).getByRole("button", { name: "More actions" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      within(toolbar()).getByRole("button", { name: "More actions" }),
    ).toHaveFocus();
  });

  it("measures again when the toolbar gets wider", async () => {
    const observers = layOut(300);
    renderApp();
    await subject("Welcome to the demo");
    expect(buttons()).toContain("More actions");
    layOut(800);
    act(() => {
      for (const observer of observers) observer();
    });
    expect(buttons()).not.toContain("More actions");
  });
});
