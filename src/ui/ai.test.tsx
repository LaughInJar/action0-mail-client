import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import type { AiServiceConfig } from "../ai/types";
import type { AppSettings } from "../state/settings";
import { UI_STATE_KEY } from "../state/uiStore";
import { fakeAiBackend } from "../test/aiBackend";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const CLAUDE: AiServiceConfig = { id: "c1", kind: "anthropic" };

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const panel = () => screen.findByRole("region", { name: "AI assistant" });
const menuEntry = async (name: string | RegExp) =>
  within(await screen.findByRole("menu")).getByRole("menuitem", { name });
// The composer's editor loads on first use.
const composer = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const editorOf = () => {
  const body = document.getElementById("composer-body");
  return body && "editor" in body ? (body.editor as Editor) : undefined;
};

/** Claude set up (its first-use note already seen), plus `settings`. */
function withAi(settings: Partial<AppSettings> = {}) {
  window.localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({
      state: {
        settings: { aiServices: [CLAUDE], aiNoticed: ["c1"], ...settings },
      },
      version: 1,
    }),
  );
}

async function settingsSection(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Settings" },
    { timeout: 5000 },
  );
  return within(dialog).getByRole("region", { name: "AI assistant" });
}

describe("AI assistance", () => {
  it("shows no AI buttons until a service is set up", async () => {
    const { user } = renderApp({ ai: fakeAiBackend().backend });
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      within(await screen.findByRole("menu")).queryByRole("menuitem", {
        name: /AI/,
      }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard("b");
    expect(
      screen.queryByRole("region", { name: "AI assistant" }),
    ).not.toBeInTheDocument();
  });

  it("adds Claude in Settings after testing the key", async () => {
    const ai = fakeAiBackend();
    const { user, services } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    const section = await settingsSection(user);
    expect(section).toHaveTextContent("No AI service is set up yet.");
    await user.click(
      within(section).getByRole("button", { name: "Add AI service" }),
    );
    // The web app can't sign in with ChatGPT.
    expect(
      within(section).getByRole("radio", { name: /^ChatGPT/ }),
    ).toBeDisabled();
    expect(
      within(section).getByRole("radio", { name: /^Claude/ }),
    ).toBeChecked();
    await user.type(within(section).getByLabelText("API key"), "sk-ant-123");
    await user.click(
      within(section).getByRole("checkbox", {
        name: /^Remember in this browser/,
      }),
    );
    await user.click(
      within(section).getByRole("button", { name: "Test and add" }),
    );

    const list = await within(section).findByRole("list", {
      name: "AI services",
    });
    expect(list).toHaveTextContent("Claude");
    expect(list).toHaveTextContent("Key remembered in this browser");
    expect([...ai.keys.values()]).toEqual(["sk-ant-123"]);
    expect(services.uiStore.getState().settings.aiServices).toEqual([
      expect.objectContaining({ kind: "anthropic", remember: true }),
    ]);
  });

  it("doesn't add a service whose key is refused", async () => {
    const ai = fakeAiBackend({
      failure: { status: 401, type: "authentication_error" },
    });
    const { user, services } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    const section = await settingsSection(user);
    await user.click(
      within(section).getByRole("button", { name: "Add AI service" }),
    );
    await user.type(within(section).getByLabelText("API key"), "wrong");
    await user.click(
      within(section).getByRole("button", { name: "Test and add" }),
    );
    expect(await within(section).findByRole("alert")).toHaveTextContent(
      "Claude didn’t accept the key.",
    );
    expect(services.uiStore.getState().settings.aiServices).toEqual([]);
    expect(ai.keys.size).toBe(0);
  });

  it("summarizes with b, answers follow-ups, and keeps them while elsewhere", async () => {
    withAi();
    const ai = fakeAiBackend({
      keyed: ["c1"],
      answer: (asked) =>
        asked.messages.length === 1
          ? "The demo **welcomes** you.\n\n- Try the keys"
          : "Nothing is due.",
    });
    const { user } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    await user.keyboard("b");
    const region = await panel();
    expect(await within(region).findByText("welcomes")).toContainHTML(
      "<strong>welcomes</strong>",
    );
    expect(within(region).getByRole("listitem")).toHaveTextContent(
      "Try the keys",
    );
    const [first] = ai.asked;
    expect(first?.model).toBe("claude-sonnet-5-5");
    expect(first?.system).toContain("Always answer in American English");
    expect(first?.messages[0]?.content).toMatch(
      /^<mail>\nFrom: .*\nSubject: Welcome to the demo\n/s,
    );
    expect(first?.messages[0]?.content).toMatch(/Summarize this email\.$/);

    await user.type(
      within(region).getByRole("textbox", { name: "Ask about this mail…" }),
      "Anything due?{Enter}",
    );
    expect(await within(region).findByText("Nothing is due.")).toBeVisible();
    expect(ai.asked[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(ai.asked[1]?.messages[2]?.content).toBe("Anything due?");

    // Another message and back: the answers are still there.
    await user.keyboard("{Escape}");
    await user.keyboard("j");
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "AI assistant" }),
      ).not.toBeInTheDocument();
    });
    await user.keyboard("k");
    expect(await panel()).toHaveTextContent("Nothing is due.");
    expect(ai.asked).toHaveLength(2);
  });

  it("asks before a service's first use", async () => {
    withAi({ aiNoticed: [] });
    const ai = fakeAiBackend({ keyed: ["c1"] });
    const { user, services } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    await user.keyboard("b");
    let note = await screen.findByRole("alertdialog", {
      name: "Send mail to Claude?",
    });
    expect(
      within(note).getByRole("link", { name: "What Claude does with it" }),
    ).toHaveAttribute("href", expect.stringContaining("privacy.claude.com"));
    await user.click(within(note).getByRole("button", { name: "Cancel" }));
    expect(ai.asked).toHaveLength(0);

    await user.click(
      within(await panel()).getByRole("button", { name: "Close the AI panel" }),
    );
    await user.keyboard("b");
    note = await screen.findByRole("alertdialog", {
      name: "Send mail to Claude?",
    });
    await user.click(within(note).getByRole("button", { name: "Continue" }));
    expect(
      await within(await panel()).findByText("An answer from the AI."),
    ).toBeVisible();
    expect(services.uiStore.getState().settings.aiNoticed).toEqual(["c1"]);
  });

  it("summarizes the whole conversation in conversation view", async () => {
    withAi({ conversations: true });
    const ai = fakeAiBackend({ keyed: ["c1"] });
    const { user } = renderApp({
      ai: ai.backend,
      hash: demoHash("inbox", "trip-1"),
    });
    await subject(/Trip to Lake Como/);
    await user.keyboard("b");
    expect(
      await within(await panel()).findByText("An answer from the AI."),
    ).toBeVisible();
    const content = ai.asked[0]?.messages[0]?.content ?? "";
    expect(content).toContain("--- Message 1 of 3 ---");
    expect(content).toContain("Booked! The tickets are attached.");
    expect(content).toMatch(/Summarize this conversation\.$/);
    expect(ai.asked[0]?.system).toContain("a conversation of 3 emails");
  });

  it("says what's wrong with a key, with a way to Settings", async () => {
    withAi();
    const { user } = renderApp({ ai: fakeAiBackend().backend });
    await subject("Welcome to the demo");
    await user.keyboard("b");
    const region = await panel();
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "The key for Claude isn’t known in this browser session.",
    );
    await user.click(
      within(region).getByRole("button", { name: "Open settings" }),
    );
    expect(
      await screen.findByRole(
        "dialog",
        { name: "Settings" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it("writes a reply with Reply with AI, and Undo takes it back", async () => {
    withAi();
    const ai = fakeAiBackend({
      keyed: ["c1"],
      answer: () => "Thanks for the welcome!\n\nBest regards",
    });
    const { user } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await menuEntry("Reply with AI"));
    const dialog = await composer(/Re: Welcome to the demo/);
    const field = within(dialog).getByRole("textbox", {
      name: "AI instruction",
    });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    await user.type(field, "say thanks{Enter}");
    await waitFor(() => {
      expect(editorOf()?.getText()).toContain("Thanks for the welcome!");
    });
    const [asked] = ai.asked;
    expect(asked?.system).toContain("You write email text for");
    expect(asked?.system).toContain("in the language of the email");
    expect(asked?.messages[0]?.content).toMatch(/^<mail>\n/);
    expect(asked?.messages[0]?.content).toMatch(/Instruction: say thanks$/);

    await user.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(editorOf()?.getText().trim()).toBe("");
  });

  it("rewrites only the selected text with a quick change", async () => {
    withAi();
    const ai = fakeAiBackend({ keyed: ["c1"], answer: () => "Short." });
    const { user } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");
    const editor = editorOf();
    act(() => {
      editor?.commands.setContent("<p>Hello there. This is long.</p>");
      editor?.commands.setTextSelection({ from: 14, to: 27 });
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Write with AI (Ctrl+J)" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Shorter" }));
    await waitFor(() => {
      expect(editor?.getText()).toBe("Hello there. Short.");
    });
    expect(ai.asked[0]?.system).toContain("Rewrite only the part");
    expect(ai.asked[0]?.messages[0]?.content).toContain(
      "<part>\nThis is long.\n</part>",
    );
  });

  it("offers ChatGPT where the app can sign in with it", async () => {
    const ai = fakeAiBackend({ keeps: "vault" });
    const { user, services } = renderApp({ ai: ai.backend });
    await subject("Welcome to the demo");
    const section = await settingsSection(user);
    await user.click(
      within(section).getByRole("button", { name: "Add AI service" }),
    );
    await user.click(within(section).getByRole("radio", { name: /^ChatGPT/ }));
    expect(section).toHaveTextContent("Requests count toward your plan");
    expect(
      within(section).queryByRole("checkbox", { name: /^Remember/ }),
    ).not.toBeInTheDocument();
    await user.click(
      within(section).getByRole("button", { name: "Continue with ChatGPT" }),
    );
    expect(
      await within(section).findByText("Signed in as me@example.com"),
    ).toBeVisible();
    expect(services.uiStore.getState().settings.aiServices).toEqual([
      expect.objectContaining({ kind: "chatgpt", account: "me@example.com" }),
    ]);
  });

  it("tries the demo AI, which can be stopped", async () => {
    withAi({ aiServices: [{ id: "demo-ai", kind: "demo" }], aiNoticed: [] });
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("b");
    const region = await panel();
    await within(region).findByText(/The sender/);
    await user.click(within(region).getByRole("button", { name: "Stop" }));
    expect(await within(region).findByText("Stopped.")).toBeVisible();
    expect(region).not.toHaveTextContent("Next step");
  });
});
