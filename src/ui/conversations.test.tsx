import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { asMessageId, asThreadId } from "../core/ids";
import { createDemoData } from "../providers/fake/demoData";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import type { AppSettings } from "../state/settings";
import { UI_STATE_KEY } from "../state/uiStore";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const option = (name: RegExp) => screen.findByRole("option", { name });
const tripRow = () => option(/Trip to Lake Como/);
const messagesOf = () => screen.getByRole("list", { name: "Messages" });
/** The conversation's messages (not lists inside them, like attachments). */
const messageItems = () => Array.from(messagesOf().children) as HTMLElement[];

function withSettings(settings: Partial<AppSettings>) {
  window.localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({ state: { settings }, version: 1 }),
  );
}

/** The demo in conversation view, opened on the trip conversation. */
function openTrip(options: Parameters<typeof renderApp>[0] = {}) {
  withSettings({ conversations: true });
  const app = renderApp({ hash: demoHash("inbox", "trip-1"), ...options });
  const provider = app.services.registry.list()[0]
    ?.provider as FakeMailProvider;
  return { ...app, provider };
}

const tripIds = ["trip-1", "trip-2", "trip-3"].map(asMessageId);

describe("conversation view", () => {
  it("is off by default: one row per message", async () => {
    renderApp();
    await subject("Welcome to the demo");
    // Anna's two Inbox messages are rows of their own.
    await option(/Booked! The tickets/);
    expect(
      screen.getAllByRole("option", { name: /Trip to Lake Como/ }),
    ).toHaveLength(2);
    expect(await option(/Booked! The tickets/)).toBeInTheDocument();
  });

  it("shows one row per conversation: senders and count", async () => {
    openTrip();
    const row = await tripRow();
    expect(row).toHaveTextContent(/^Anna, me3 messages/);
    expect(row).toHaveTextContent("Booked! The tickets are attached.");
  });

  it("opens the newest message, keeps older read ones as a line", async () => {
    const { user } = openTrip();
    await subject(/Trip to Lake Como/);
    const messages = messagesOf();
    expect(messageItems()).toHaveLength(3);
    expect(messages).toHaveTextContent("See you on Friday");
    expect(
      within(messages).getByRole("button", { name: /^Anna Berger.*Shall we/ }),
    ).toBeInTheDocument();
    expect(
      within(messages).getByRole("button", { name: /^me.*Sounds good/ }),
    ).toBeInTheDocument();

    // p moves the cursor up, Enter opens that message.
    await user.keyboard("p");
    const items = messageItems();
    expect(items[1]).toHaveAttribute("aria-current", "true");
    await user.keyboard("{Enter}");
    expect(messages).toHaveTextContent("Friday works for me.");
    await user.keyboard("n");
    expect(items[2]).toHaveAttribute("aria-current", "true");
  });

  it("answers the message at the cursor; the draft shows in the conversation", async () => {
    const { user } = openTrip();
    await subject(/Trip to Lake Como/);
    await user.keyboard("r");
    const composer = await screen.findByRole(
      "dialog",
      { name: /Re: Trip to Lake Como/ },
      { timeout: 5000 },
    );
    expect(composer).toHaveTextContent("Anna Berger");
    const body = document.getElementById("composer-body");
    const editor =
      body && "editor" in body ? (body.editor as Editor) : undefined;
    act(() => {
      editor?.commands.insertContent("See you there!");
    });
    await within(composer).findByText("Saved", {}, { timeout: 4000 });
    await user.click(within(composer).getByRole("button", { name: /^Close/ }));
    await waitFor(
      () => {
        expect(
          within(messagesOf()).getByRole("button", { name: "Edit" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("archives the whole conversation, and z brings it back", async () => {
    const { user, provider } = openTrip();
    await subject(/Trip to Lake Como/);
    await user.keyboard("a");
    expect(await toastText("Archived 1 conversation")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Trip to Lake Como/ }),
    ).not.toBeInTheDocument();
    await waitFor(async () => {
      const thread = await provider.getThread(asThreadId("t-trip"));
      expect(
        thread.messages.some((m) => m.mailboxIds.includes("inbox" as never)),
      ).toBe(false);
    });

    await user.keyboard("z");
    expect(await tripRow()).toHaveTextContent(/3 messages/);
  });

  it("stars the newest message, or unstars them all", async () => {
    const { user, provider } = openTrip();
    await subject(/Trip to Lake Como/);
    await user.keyboard("s");
    expect(await toastText("Starred 1 conversation")).toBeInTheDocument();
    await waitFor(async () => {
      const { messages } = await provider.getThread(asThreadId("t-trip"));
      expect(messages.map((m) => m.flags.flagged)).toEqual([
        false,
        false,
        true,
      ]);
    });
    await user.keyboard("s");
    expect(await toastText("Unstarred 1 conversation")).toBeInTheDocument();
    await waitFor(async () => {
      const { messages } = await provider.getThread(asThreadId("t-trip"));
      expect(messages.some((m) => m.flags.flagged)).toBe(false);
    });
  });

  it("shows labels of the whole conversation in the picker", async () => {
    const { user } = openTrip();
    await subject(/Trip to Lake Como/);
    await user.keyboard("l");
    const picker = await screen.findByRole("dialog", { name: /Labels/ });
    expect(picker).toHaveTextContent("(1 conversation)");
    expect(
      within(picker).getByRole("option", { name: "Personal" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("marks every unread message read", async () => {
    withSettings({ conversations: true, markRead: "immediately" });
    const { services } = renderApp({
      hash: demoHash("inbox", "trip-1"),
      data: () => {
        const data = createDemoData(TEST_NOW);
        return {
          ...data,
          messages: data.messages.map((message) =>
            tripIds.includes(message.id) && message.id !== "trip-2"
              ? { ...message, flags: { ...message.flags, seen: false } }
              : message,
          ),
        };
      },
    });
    await subject(/Trip to Lake Como/);
    // Both unread messages are open.
    expect(messagesOf()).toHaveTextContent("Shall we book the train");
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    await waitFor(async () => {
      const { messages } = await provider.getThread(asThreadId("t-trip"));
      expect(messages.every((m) => m.flags.seen)).toBe(true);
    });
    expect(await tripRow()).not.toHaveTextContent(/^Unread/);
  });

  it("moves a conversation up when a new message joins it", async () => {
    const { provider } = openTrip({ hash: demoHash("inbox") });
    await subject("Welcome to the demo");
    await tripRow();
    const reply = {
      to: [{ address: "anna.berger@example.org" }],
      cc: [],
      bcc: [],
      subject: "Re: Trip to Lake Como",
      html: "<p>Great!</p>",
      text: "Great!",
      attachments: [],
      threading: { threadId: asThreadId("t-trip"), references: [] },
    };
    const { id } = await provider.saveDraft(reply);
    await provider.sendDraft({ ...reply, id });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => {
      expect(screen.getAllByRole("option")[0]).toHaveTextContent(
        /Anna, me4 messages/,
      );
    });
  });

  it("searches conversations", async () => {
    const { user } = openTrip({ hash: demoHash("inbox") });
    await subject("Welcome to the demo");
    await user.keyboard("/");
    await user.keyboard("Lake Como");
    await waitFor(
      () => {
        expect(
          screen.getByRole("listbox", { name: /Results for/ }),
        ).toHaveTextContent(/Anna, me3 messages/);
      },
      { timeout: 3000 },
    );
  });
});
