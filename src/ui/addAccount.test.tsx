import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import { validateGoogleClientId } from "../app/googleSetup";
import { validateMicrosoftClientId } from "../app/microsoftSetup";
import { StaticAuthSession } from "../auth/staticSession";
import { MailError } from "../core/errors";
import { asAccountId } from "../core/ids";
import type { Account } from "../core/model";
import { createDemoData } from "../providers/fake/demoData";
import { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { createDemoModule } from "../providers/fake/module";
import { renderApp, TEST_NOW } from "../test/renderApp";

const JANE: Account = {
  id: asAccountId("gmail:jane@example.com"),
  type: "gmail",
  email: "jane@example.com",
};
const CLIENT_ID = "424727749781-abcdef.apps.googleusercontent.com";

/** A stand-in for the Gmail module: no Google involved. */
function googleLikeModule({
  connect = () =>
    Promise.resolve({ account: JANE, auth: new StaticAuthSession() }),
  prepare,
}: {
  connect?: ProviderModule["connect"];
  prepare?: () => Promise<void>;
} = {}): ProviderModule {
  return {
    type: "gmail",
    label: "Google",
    ...(prepare ? { prepare } : {}),
    connect,
    restore: () => new StaticAuthSession(),
    createProvider: () => new FakeMailProvider(createDemoData(TEST_NOW)),
  };
}

/** A setup like the real one, but registering the stand-in module. */
function setupFor(
  module: ProviderModule,
  validate: ProviderSetup["validate"] = validateGoogleClientId,
) {
  let stored: string | undefined;
  return (registry: AccountRegistry): ProviderSetup[] => [
    {
      type: module.type,
      current: () =>
        stored === undefined ? undefined : { value: stored, source: "browser" },
      validate,
      apply: (value) => {
        stored = value.trim();
        registry.registerModule(module);
      },
    },
  ];
}
const googleSetup = (module: ProviderModule) => setupFor(module);

const MAX: Account = {
  id: asAccountId("microsoft:max@contoso.com"),
  type: "microsoft",
  email: "max@contoso.com",
};

/** A stand-in for the Microsoft module: no MSAL involved. */
function microsoftLikeModule(): ProviderModule {
  return {
    type: "microsoft",
    label: "Microsoft",
    connect: () =>
      Promise.resolve({ account: MAX, auth: new StaticAuthSession() }),
    restore: () => new StaticAuthSession(),
    createProvider: () => new FakeMailProvider(createDemoData(TEST_NOW)),
  };
}

const demoOnly = () => [
  createDemoModule({ latencyMs: 0, data: () => createDemoData(TEST_NOW) }),
];
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });

describe("Add account dialog", () => {
  it("opens from the Accounts panel and lists the account types", async () => {
    const { user } = renderApp();
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await user.click(screen.getByText("Accounts"));
    await user.click(screen.getByRole("button", { name: "Add account" }));

    const dialog = await screen.findByRole("dialog", { name: "Add account" });
    expect(
      within(dialog).getByRole("button", { name: /^Demo account/ }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", {
        name: /^Other mail server.*Coming later/,
      }),
    ).toBeDisabled();
    // Neither modules nor setups for Google and Microsoft in this test.
    expect(
      within(dialog).queryByRole("button", { name: /^Google/ }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /^Microsoft/ }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("goes straight to connecting when Google is already configured", async () => {
    const { user } = renderApp({
      modules: [...demoOnly(), googleLikeModule()],
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await user.click(screen.getByText("Accounts"));
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /^Google/ }));

    expect(
      await screen.findByRole("heading", { name: "Connect Google" }),
    ).toBeInTheDocument();
    // Configured by the build: nothing to change here.
    expect(
      screen.queryByRole("button", { name: "Use a different client ID" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    expect(await toastText("Connected jane@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.hash).toContain(encodeURIComponent(JANE.id));
  });
});

describe("Google setup in the wizard", () => {
  it("takes the client ID, then connects and opens the new Inbox", async () => {
    const { user } = renderApp({
      signedIn: false,
      modules: demoOnly(),
      setups: googleSetup(googleLikeModule()),
    });
    await user.click(
      screen.getByRole("button", { name: /^Google.*One-time setup/ }),
    );
    expect(
      screen.getByRole("heading", { name: "Set up Google" }),
    ).toBeInTheDocument();
    // The exact origin Google needs to know.
    expect(screen.getByText(window.location.origin)).toBeInTheDocument();

    const field = screen.getByLabelText("Client ID");
    await user.type(field, "GOCSPX-secret");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/client secret/);
    expect(field).toHaveAttribute("aria-invalid", "true");

    await user.clear(field);
    await user.type(field, CLIENT_ID);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(
      await screen.findByRole("heading", { name: "Connect Google" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(await toastText("Connected jane@example.com")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Inbox" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toContain(encodeURIComponent(JANE.id));
  });

  it("can go back to change a client ID entered in this browser", async () => {
    const { user } = renderApp({
      signedIn: false,
      modules: demoOnly(),
      setups: googleSetup(googleLikeModule()),
    });
    await user.click(screen.getByRole("button", { name: /^Google/ }));
    await user.type(screen.getByLabelText("Client ID"), CLIENT_ID);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    await user.click(
      await screen.findByRole("button", { name: "Use a different client ID" }),
    );
    expect(screen.getByLabelText("Client ID")).toHaveValue(CLIENT_ID);
  });
});

describe("connecting", () => {
  it("waits for Google's sign-in script before allowing the click", async () => {
    let finish: () => void = () => undefined;
    const prepare = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const { user } = renderApp({
      signedIn: false,
      modules: [...demoOnly(), googleLikeModule({ prepare })],
    });
    await user.click(screen.getByRole("button", { name: /^Google/ }));
    expect(
      screen.getByRole("button", { name: "Loading Google sign-in…" }),
    ).toBeDisabled();
    finish();
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
  });

  it("explains a failure in place and lets you try again", async () => {
    let attempts = 0;
    const connect: ProviderModule["connect"] = () => {
      attempts++;
      return attempts === 1
        ? Promise.reject(
            new MailError(
              "auth-required",
              "The Google sign-in window was blocked. Please allow popups for this site.",
            ),
          )
        : Promise.resolve({ account: JANE, auth: new StaticAuthSession() });
    };
    const { user } = renderApp({
      signedIn: false,
      modules: [...demoOnly(), googleLikeModule({ connect })],
    });
    await user.click(screen.getByRole("button", { name: /^Google/ }));
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/allow popups/);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await toastText("Connected jane@example.com")).toBeInTheDocument();
  });

  it("helps with the errors Google shows in its own window", async () => {
    const { user } = renderApp({
      signedIn: false,
      modules: [...demoOnly(), googleLikeModule()],
    });
    await user.click(screen.getByRole("button", { name: /^Google/ }));
    await user.click(screen.getByText("Did Google show an error?"));
    expect(screen.getByText(/no registered origin/)).toBeInTheDocument();
    expect(screen.getAllByText(window.location.origin).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/verification process/)).toBeInTheDocument();
  });
});

describe("Microsoft setup in the wizard", () => {
  it("shows the Entra checklist with the redirect URI, takes the client ID and connects", async () => {
    const { user } = renderApp({
      signedIn: false,
      modules: demoOnly(),
      setups: setupFor(microsoftLikeModule(), validateMicrosoftClientId),
    });
    await user.click(
      screen.getByRole("button", { name: /^Microsoft.*One-time setup/ }),
    );
    expect(
      screen.getByRole("heading", { name: "Set up Microsoft" }),
    ).toBeInTheDocument();
    // The exact redirect URI to register, of type SPA.
    expect(
      screen.getByText(`${window.location.origin}/redirect.html`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "App registrations" }),
    ).toHaveAttribute("href", expect.stringContaining("entra.microsoft.com"));

    const field = screen.getByLabelText("Client ID");
    await user.type(field, "Abc8Q~notTheId");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/client secret/);

    await user.clear(field);
    await user.type(field, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(
      await screen.findByRole("heading", { name: "Connect Microsoft" }),
    ).toBeInTheDocument();
    await user.click(screen.getByText("Did Microsoft show an error?"));
    expect(screen.getByText(/AADSTS50011/)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continue with Microsoft" }),
    );
    expect(await toastText("Connected max@contoso.com")).toBeInTheDocument();
    expect(window.location.hash).toContain(encodeURIComponent(MAX.id));
  });
});
