import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MailServerError,
  type MailServerDiscovery,
} from "../accounts/mailServer";
import { asAccountId } from "../core/ids";
import { fakeImapBridge, imapMessage } from "../test/imapBridge";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const GMX: MailServerDiscovery = {
  source: "ispdb",
  providerName: "GMX",
  settings: {
    imap: { host: "imap.gmx.net", port: 993, security: "tls" },
    smtp: { host: "mail.gmx.net", port: 465, security: "tls" },
    username: "me@gmx.at",
  },
  enableImapUrl: "https://support.gmx.com/pop-imap/toggle.html",
};

const CERTIFICATE = {
  sha256: "AB:CD:EF:01",
  subject: "CN=mail.home.example",
  issuer: "CN=mail.home.example",
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2027-01-01T00:00:00Z",
  names: ["mail.home.example"],
  server: "imap" as const,
};

const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });

type User = ReturnType<typeof renderApp>["user"];

/** Add account → Other mail server → the address and name. */
async function enterAddress(user: User, address: string) {
  await user.click(screen.getByText("Accounts"));
  await user.click(screen.getByRole("button", { name: "Add account" }));
  const dialog = await screen.findByRole("dialog", { name: "Add account" });
  await user.click(
    within(dialog).getByRole("button", { name: /^Other mail server/ }),
  );
  await user.type(screen.getByLabelText("Email address"), address);
  await user.type(screen.getByLabelText("Your name"), "Me Myself");
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

describe("adding a mail server account", () => {
  it("finds the settings, connects with the password and opens the Inbox", async () => {
    const fake = fakeImapBridge({
      discovery: GMX,
      messages: [imapMessage("m1", "f:INBOX", { subject: "Hello from GMX" })],
    });
    const { user, services } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@gmx.at");

    expect(
      await screen.findByRole("heading", { name: "me@gmx.at" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Settings for GMX. The settings were found in Mozilla’s provider database.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "How to switch it on" }),
    ).toHaveAttribute("href", GMX.enableImapUrl);

    await user.type(screen.getByLabelText("Password"), "app-password");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await toastText("Connected me@gmx.at")).toBeInTheDocument();
    expect(fake.connected[0]).toEqual({
      address: "me@gmx.at",
      name: "Me Myself",
      settings: GMX.settings,
      credentials: { password: "app-password" },
    });
    expect(
      services.registry.get(asAccountId("imap:me@gmx.at"))?.account.type,
    ).toBe("imap");
    expect(
      await screen.findByRole("option", { name: /Hello from GMX/ }),
    ).toBeInTheDocument();
    // Role folders in a mail program's words, not Outlook's (the demo
    // account, like Gmail, has "Spam").
    expect(
      await screen.findByRole("treeitem", { name: /^Junk/ }),
    ).toBeInTheDocument();
    for (const outlook of [/^Junk Email/, /^Deleted Items/, /^Sent Items/])
      expect(
        screen.queryByRole("treeitem", { name: outlook }),
      ).not.toBeInTheDocument();
  });

  it("offers a Google address its own account type, or IMAP anyway", async () => {
    const fake = fakeImapBridge({
      discovery: {
        source: "provider",
        better: "gmail",
        settings: {
          imap: { host: "imap.gmail.com", port: 993, security: "tls" },
          smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
          username: "me@gmail.com",
        },
        appPasswordUrl: "https://myaccount.google.com/apppasswords",
      },
    });
    const { user } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@gmail.com");
    expect(
      await screen.findByText(/This is a Google address/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add as Gmail account" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use IMAP anyway" }));
    expect(
      await screen.findByRole("link", { name: "Create an app password" }),
    ).toHaveAttribute("href", "https://myaccount.google.com/apppasswords");
  });

  it("asks before trusting a certificate the system doesn't, then trusts that one", async () => {
    const fake = fakeImapBridge({
      connectFailures: [
        new MailServerError("untrusted", "unknown issuer", {
          server: "imap",
          certificate: CERTIFICATE,
        }),
      ],
    });
    const { user } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@home.example");
    // Nothing found: the usual names, editable.
    expect(
      await screen.findByText(/No settings were found/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Server", { selector: "input" })[0],
    ).toHaveValue("imap.home.example");

    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByRole("heading", { name: "Untrusted certificate" }),
    ).toBeInTheDocument();
    expect(screen.getByText("AB:CD:EF:01")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Trust it for this account" }),
    );
    expect(await toastText("Connected me@home.example")).toBeInTheDocument();
    expect(fake.connected).toHaveLength(2);
    expect(fake.connected[1]?.trust).toBe("AB:CD:EF:01");
  });

  it("explains a refused password with the app-password hint", async () => {
    const fake = fakeImapBridge({
      discovery: {
        ...GMX,
        appPasswordUrl: "https://example.org/app-passwords",
      },
      connectFailures: [new MailServerError("auth", "LOGIN failed")],
    });
    const { user } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@gmx.at");
    await user.type(await screen.findByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server refused the password. Many providers need an app password",
    );
  });

  it("signs in again with a password typed into the Reconnect bar", async () => {
    const fake = fakeImapBridge({ discovery: GMX });
    const { user, services } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@gmx.at");
    await user.type(await screen.findByLabelText("Password"), "old");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await toastText("Connected me@gmx.at");

    act(() => {
      services.registry.get(asAccountId("imap:me@gmx.at"))?.auth.markExpired();
    });
    const field = await screen.findByLabelText("New password for me@gmx.at");
    await user.type(field, "new");
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => {
      expect(fake.bridge.reconnect).toHaveBeenCalledWith(
        "imap:me@gmx.at",
        "new",
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByLabelText("New password for me@gmx.at"),
      ).not.toBeInTheDocument();
    });
  });

  it("can forget a trusted certificate", async () => {
    const fake = fakeImapBridge({
      connectFailures: [
        new MailServerError("untrusted", "unknown issuer", {
          certificate: CERTIFICATE,
        }),
      ],
    });
    const { user } = renderApp({ imap: fake.bridge });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await enterAddress(user, "me@home.example");
    await user.type(await screen.findByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(
      await screen.findByRole("button", { name: "Trust it for this account" }),
    );
    await toastText("Connected me@home.example");

    await user.click(
      await screen.findByRole("button", { name: "Forget certificate" }),
    );
    const question = await screen.findByRole("alertdialog", {
      name: "Forget the trusted certificate?",
    });
    await user.click(within(question).getByRole("button", { name: "Forget" }));
    await waitFor(() => {
      expect(fake.bridge.forgetCertificate).toHaveBeenCalledWith(
        "imap:me@home.example",
      );
    });
  });
});
