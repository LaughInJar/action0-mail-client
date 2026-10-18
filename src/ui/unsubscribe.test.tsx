import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailError } from "../core/errors";
import type { Unsubscribe } from "../core/model";
import { createDemoData } from "../providers/fake/demoData";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const confirmation = () =>
  screen.findByRole("alertdialog", { name: "Unsubscribe from Weekly Digest?" });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The demo, with the Weekly Digest offering only `unsubscribe`. */
const digestOffering = (unsubscribe: Unsubscribe) => () => {
  const data = createDemoData(TEST_NOW);
  return {
    ...data,
    messages: data.messages.map((message) =>
      message.id === "newsletter" ? { ...message, unsubscribe } : message,
    ),
  };
};

function openDigest(data?: () => ReturnType<typeof createDemoData>) {
  const app = renderApp({
    hash: demoHash("inbox", "newsletter"),
    ...(data ? { data } : {}),
  });
  const provider = app.services.registry.list()[0]
    ?.provider as FakeMailProvider;
  return { ...app, provider };
}

describe("unsubscribe", () => {
  it("asks first, with Cancel as the default", async () => {
    const { user, provider } = openDigest();
    await subject("This week in web development");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
    const dialog = await confirmation();
    expect(dialog).toHaveTextContent(
      "Weekly Digest will be asked to stop sending you mail. This can’t be undone.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(provider.oneClickRequests).toEqual([]);
  });

  it("unsubscribes with one click", async () => {
    const { user, provider } = openDigest();
    await subject("This week in web development");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await user.click(
      within(await confirmation()).getByRole("button", { name: "Unsubscribe" }),
    );
    expect(
      await toastText("Unsubscribed from Weekly Digest"),
    ).toBeInTheDocument();
    expect(provider.oneClickRequests).toEqual([
      "https://news.example/unsubscribe?u=demo",
    ]);
    expect(screen.getByText("Unsubscribed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Unsubscribe" }),
    ).not.toBeInTheDocument();
  });

  it("sends the unsubscribe mail when one-click fails; it lands in Sent", async () => {
    const { user, provider } = openDigest();
    vi.spyOn(provider, "oneClickUnsubscribe").mockRejectedValue(
      new MailError("network", "Unreachable"),
    );
    await subject("This week in web development");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await user.click(
      within(await confirmation()).getByRole("button", { name: "Unsubscribe" }),
    );
    expect(
      await toastText("Unsubscribe mail sent to unsubscribe@news.example"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /^Sent/ }));
    const sent = await screen.findByRole("option", { name: /Unsubscribe/ });
    expect(sent).toHaveTextContent("unsubscribe@news.example");
  });

  it("opens a page-only sender's page from the confirmation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = openDigest(
      digestOffering({ page: "https://news.example/leave" }),
    );
    await subject("This week in web development");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
    const dialog = await confirmation();
    expect(dialog).toHaveTextContent("(news.example) opens in a new tab");
    await user.click(within(dialog).getByRole("button", { name: "Open page" }));
    expect(open).toHaveBeenCalledWith(
      "https://news.example/leave",
      "_blank",
      "noopener,noreferrer",
    );
    expect(
      await toastText("Opened the unsubscribe page of Weekly Digest"),
    ).toBeInTheDocument();
  });

  it("offers the page in the toast when one-click fails", async () => {
    const { user, provider } = openDigest(
      digestOffering({
        oneClick: "https://news.example/leave",
        page: "https://news.example/leave",
      }),
    );
    vi.spyOn(provider, "oneClickUnsubscribe").mockRejectedValue(
      new MailError("network", "Unreachable"),
    );
    await subject("This week in web development");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await user.click(
      within(await confirmation()).getByRole("button", { name: "Unsubscribe" }),
    );
    expect(
      await toastText("Couldn’t unsubscribe from Weekly Digest automatically."),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open their page" });
    expect(link).toHaveAttribute("href", "https://news.example/leave");
    expect(link).toHaveAttribute("target", "_blank");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Unsubscribe" }),
      ).toBeInTheDocument();
    });
  });

  it("shows no button for mail that isn't from a list", async () => {
    renderApp({ hash: demoHash("inbox", "welcome") });
    await subject("Welcome to the demo");
    expect(
      screen.queryByRole("button", { name: "Unsubscribe" }),
    ).not.toBeInTheDocument();
  });
});
