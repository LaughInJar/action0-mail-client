import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeAndroidPlatform } from "../test/androidPlatform";
import { fakeDesktopPlatform } from "../test/desktopPlatform";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
// The editor loads on first use; on a cold CI machine that takes a moment.
const composer = (name: string) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const settings = async (user: ReturnType<typeof renderApp>["user"]) => {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" }, { timeout: 5000 });
};
const writing = (dialog: HTMLElement) =>
  within(dialog).getByRole("region", { name: "Writing" });
const language = (dialog: HTMLElement, name: string) =>
  within(dialog).findByRole("checkbox", { name });

describe("spell checking", () => {
  it("underlines in the composer, and stops when it's switched off", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");
    const body = within(dialog).getByRole("textbox", { name: "Message" });
    const subjectField = within(dialog).getByRole("textbox", {
      name: "Subject",
    });
    expect(body).toHaveAttribute("spellcheck", "true");
    expect(subjectField).toHaveAttribute("spellcheck", "true");
    // Addresses are never checked.
    expect(
      within(dialog).getByRole("combobox", { name: "To" }),
    ).toHaveAttribute("spellcheck", "false");

    const options = await settings(user);
    await user.click(
      within(writing(options)).getByRole("checkbox", {
        name: /^Check spelling/,
      }),
    );
    expect(body).toHaveAttribute("spellcheck", "false");
    expect(subjectField).toHaveAttribute("spellcheck", "false");
  });

  it("checks event titles and descriptions too, but not places", async () => {
    const { user } = renderApp({ hash: "#/calendar/week/2026-10-15" });
    await screen.findByRole("button", { name: /^Design review/ });
    await user.keyboard("c");
    const form = await screen.findByRole("region", { name: "New event" });
    expect(within(form).getByLabelText("Title")).toHaveAttribute(
      "spellcheck",
      "true",
    );
    expect(
      await within(form).findByRole("textbox", { name: "Description" }),
    ).toHaveAttribute("spellcheck", "true");
    expect(within(form).getByLabelText("Location")).toHaveAttribute(
      "spellcheck",
      "false",
    );
  });

  it("says where the browser's languages are set", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const section = writing(await settings(user));
    expect(section).toHaveTextContent(
      "in Chrome and Edge under Settings → Languages",
    );
    await user.click(
      within(section).getByRole("checkbox", { name: /^Check spelling/ }),
    );
    expect(section).not.toHaveTextContent("Chrome");
  });

  it("lets the Linux app choose among the installed dictionaries", async () => {
    const desktop = fakeDesktopPlatform();
    const spelling = desktop.platform.spelling;
    const { user } = renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    // At start: the browser's language (en-US in tests).
    await waitFor(() => {
      expect(spelling?.setLanguages).toHaveBeenCalledWith(["en-US"]);
    });

    const dialog = await settings(user);
    const english = await language(dialog, "English (United States)");
    expect(english).toBeChecked();
    // The last language can't be unticked.
    expect(english).toBeDisabled();
    expect(
      within(dialog).getAllByRole("checkbox", { name: /^German/ }),
    ).toEqual([
      within(dialog).getByRole("checkbox", { name: "German (Austria)" }),
      within(dialog).getByRole("checkbox", { name: "German (Germany)" }),
    ]);
    await user.click(
      within(dialog).getByRole("checkbox", { name: "German (Austria)" }),
    );
    await waitFor(() => {
      expect(spelling?.setLanguages).toHaveBeenLastCalledWith([
        "en-US",
        "de-AT",
      ]);
    });
    await waitFor(() => {
      expect(english).toBeEnabled();
    });
    await user.click(english);
    await waitFor(() => {
      expect(spelling?.setLanguages).toHaveBeenLastCalledWith(["de-AT"]);
    });
    expect(writing(dialog)).toHaveTextContent(
      "Right-click an underlined word for suggestions.",
    );
  });

  it("explains a Linux app without dictionaries", async () => {
    const desktop = fakeDesktopPlatform({ dictionaries: [] });
    const { user } = renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    const section = writing(await settings(user));
    expect(
      await within(section).findByText(/^No dictionaries found/),
    ).toBeInTheDocument();
  });

  it("says when the dictionaries don't load", async () => {
    const desktop = fakeDesktopPlatform({ loads: false });
    const { user } = renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    const section = writing(await settings(user));
    expect(
      await within(section).findByText(
        "The dictionaries couldn’t be loaded, so nothing is checked.",
      ),
    ).toBeInTheDocument();
  });

  it("points Windows and Android to their own settings", async () => {
    const windows = fakeDesktopPlatform({ os: "windows" });
    expect(windows.platform.spelling).toBeUndefined();
    const first = renderApp({ platform: windows.platform });
    await subject("Welcome to the demo");
    expect(writing(await settings(first.user))).toHaveTextContent(
      "Windows checks spelling in its display language",
    );
    first.unmount();

    const android = fakeAndroidPlatform();
    const second = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    expect(writing(await settings(second.user))).toHaveTextContent(
      "Tap an underlined word for suggestions.",
    );
  });
});
