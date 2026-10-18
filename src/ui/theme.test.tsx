import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY } from "../state/theme";
import { renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const radio = (name: string) => screen.getByRole("radio", { name });
const theme = () => document.documentElement.getAttribute("data-theme");
const barColors = () =>
  Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  ).map((meta) => meta.content);

// The address-bar colours from index.html (jsdom doesn't load it).
beforeEach(() => {
  for (const [scheme, color] of [
    ["light", "#ffffff"],
    ["dark", "#09090b"],
  ] as const) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    meta.media = `(prefers-color-scheme: ${scheme})`;
    document.head.append(meta);
  }
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.remove();
  });
});

describe("theme switch", () => {
  it("follows the system until a theme is chosen, and remembers it", async () => {
    const { user, unmount } = renderApp();
    await subject("Welcome to the demo");
    expect(
      screen.getByRole("radiogroup", { name: "Theme" }),
    ).toBeInTheDocument();
    expect(radio("System")).toBeChecked();
    expect(theme()).toBeNull();

    await user.click(radio("Dark"));
    expect(theme()).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(barColors()).toEqual(["#09090b", "#09090b"]);

    unmount();
    document.documentElement.removeAttribute("data-theme");
    renderApp();
    await subject("Welcome to the demo");
    expect(radio("Dark")).toBeChecked();
    expect(theme()).toBe("dark");
  });

  it("goes back to the system setting", async () => {
    window.localStorage.setItem(THEME_KEY, "light");
    const { user } = renderApp();
    await subject("Welcome to the demo");
    expect(theme()).toBe("light");
    expect(barColors()).toEqual(["#ffffff", "#ffffff"]);

    await user.click(radio("System"));
    expect(theme()).toBeNull();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(barColors()).toEqual(["#ffffff", "#09090b"]);
  });

  it("keeps the arrow keys to itself", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(radio("Light"));
    await user.keyboard("{ArrowRight}");
    expect(radio("Dark")).toBeChecked();
    await user.keyboard("{ArrowDown}");
    // The message cursor didn't move along.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Welcome to the demo",
    );
  });
});
