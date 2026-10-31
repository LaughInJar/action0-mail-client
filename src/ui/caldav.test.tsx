import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MailServerDiscovery } from "../accounts/mailServer";
import { fakeDavServer, icsEvent } from "../test/davServer";
import { fakeImapBridge, imapMessage } from "../test/imapBridge";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 20_000 });

const GMX: MailServerDiscovery = {
  source: "ispdb",
  providerName: "GMX",
  settings: {
    imap: { host: "imap.gmx.net", port: 993, security: "tls" },
    smtp: { host: "mail.gmx.net", port: 465, security: "tls" },
    username: "me@gmx.at",
  },
};

const WEEK = "#/calendar/week/2026-10-19";

const lunch = icsEvent({
  uid: "lunch",
  start: "20261020T100000Z",
  end: "20261020T110000Z",
  summary: "Team lunch",
});

const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });

type User = ReturnType<typeof renderApp>["user"];

/** Adds the GMX account through the wizard, up to its calendar step. */
async function addAccount(user: User) {
  await screen.findByRole("heading", {
    level: 1,
    name: "Welcome to the demo",
  });
  await user.click(screen.getByText("Accounts"));
  await user.click(screen.getByRole("button", { name: "Add account" }));
  const wizard = await dialog("Add account");
  await user.click(
    within(wizard).getByRole("button", { name: /^Other mail server/ }),
  );
  await user.type(screen.getByLabelText("Email address"), "me@gmx.at");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Password"), "app-password");
  await user.click(screen.getByRole("button", { name: "Connect" }));
}

function openWeek() {
  act(() => {
    window.location.hash = WEEK;
  });
}

describe("calendars of mail server accounts", () => {
  it("are found while the account is added, and shown when wanted", async () => {
    const dav = fakeDavServer({
      objects: { personal: { "lunch.ics": lunch } },
    });
    const imap = fakeImapBridge({ discovery: GMX });
    const { user } = renderApp({ imap: imap.bridge, caldav: dav.bridge });
    await addAccount(user);
    expect(
      await screen.findByText(
        "This account’s calendars are on dav.example.com. Show them in action0’s calendar too?",
      ),
    ).toBeInTheDocument();
    expect(dav.connected[0]).toMatchObject({
      key: "imap:me@gmx.at",
      login: { sameAsMail: true },
    });
    await user.click(screen.getByRole("button", { name: "Show them" }));
    expect(await toastText("Connected me@gmx.at")).toBeInTheDocument();

    openWeek();
    expect(
      await screen.findByRole("button", { name: /^Team lunch/ }),
    ).toBeInTheDocument();
  });

  it("can be set up later from the calendar", async () => {
    const dav = fakeDavServer({
      objects: { personal: { "lunch.ics": lunch } },
    });
    const imap = fakeImapBridge({ discovery: GMX });
    const { user } = renderApp({ imap: imap.bridge, caldav: dav.bridge });
    await addAccount(user);
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    await toastText("Connected me@gmx.at");
    expect(dav.bridge.remove).toHaveBeenCalledWith("imap:me@gmx.at");

    openWeek();
    const section = await screen.findByRole("region", { name: "me@gmx.at" });
    await user.click(
      within(section).getByRole("button", { name: "Set up calendar" }),
    );
    const setup = await dialog("Calendars of me@gmx.at");
    expect(
      await within(setup).findByText("Found: dav.example.com."),
    ).toBeInTheDocument();
    await user.click(within(setup).getByRole("button", { name: "Connect" }));
    expect(
      await toastText("Calendars of me@gmx.at are shown"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Team lunch/ }),
    ).toBeInTheDocument();
  });

  it("answer invitation mails, adding the event and replying by mail", async () => {
    const invitation = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:review-1",
      "DTSTAMP:20261001T000000Z",
      "DTSTART:20261021T100000Z",
      "DTEND:20261021T110000Z",
      "SUMMARY:Design review",
      "ORGANIZER;CN=Anna Berger:mailto:anna@example.org",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@gmx.at",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const dav = fakeDavServer();
    const imap = fakeImapBridge({
      discovery: GMX,
      messages: [
        imapMessage("inv", "f:INBOX", {
          subject: "Invitation: Design review",
          to: [{ address: "me@gmx.at" }],
          calendar: invitation,
        }),
      ],
    });
    const { user } = renderApp({ imap: imap.bridge, caldav: dav.bridge });
    await addAccount(user);
    await user.click(await screen.findByRole("button", { name: "Show them" }));
    await user.click(
      await screen.findByRole("option", { name: /Invitation: Design review/ }),
    );
    const bar = await screen.findByRole("region", { name: "Invitation" });
    expect(
      await within(bar).findByText(
        "Not in your calendar yet: answering adds it to “Personal”.",
      ),
    ).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Yes" }));
    expect(await toastText("Accepted “Design review”")).toBeInTheDocument();
    await waitFor(() => {
      expect(dav.text("personal", "review-1.ics")).toContain(
        "PARTSTAT=ACCEPTED",
      );
    });
    await waitFor(() => {
      expect(imap.sent).toHaveLength(1);
    });
    expect(imap.sent[0]?.envelope).toEqual({
      from: "me@gmx.at",
      to: ["anna@example.org"],
    });
    expect(imap.sent[0]?.raw).toContain("text/calendar; method=REPLY");
    await waitFor(() => {
      expect(
        within(bar).getByRole("button", { name: "Yes", pressed: true }),
      ).toBeInTheDocument();
    });
  });
});

describe("contacts on the calendar server", () => {
  it("suggest addresses, then people from recent mail", async () => {
    const dav = fakeDavServer({
      objects: { personal: { "lunch.ics": lunch } },
      addressBooks: {
        contacts: {
          "annika.vcf": [
            "BEGIN:VCARD",
            "VERSION:4.0",
            "FN:Annika Bauer",
            "EMAIL:annika@example.net",
            "END:VCARD",
          ].join("\r\n"),
        },
      },
    });
    const imap = fakeImapBridge({
      discovery: GMX,
      messages: [
        imapMessage("m1", "f:INBOX", {
          from: { name: "Anna Berger", address: "anna@example.org" },
        }),
      ],
    });
    const { user } = renderApp({ imap: imap.bridge, caldav: dav.bridge });
    await addAccount(user);
    expect(
      await screen.findByText(
        "This account’s calendars and contacts are on dav.example.com. Show them in action0 too?",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show them" }));
    await toastText("Connected me@gmx.at");
    await user.keyboard("c");
    const compose = await dialog("New message");
    await user.type(within(compose).getByLabelText("To"), "ann");
    const list = await within(compose).findByRole("listbox", {
      name: "Suggestions",
    });
    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Annika Bauer") as unknown,
        expect.stringContaining("Anna Berger") as unknown,
      ]);
    });
  });
});

describe("calendar-only servers", () => {
  it("are added with their own login, shown, and removed", async () => {
    const dav = fakeDavServer({
      objects: { personal: { "lunch.ics": lunch } },
    });
    const { user } = renderApp({ caldav: dav.bridge, hash: WEEK });
    await user.click(
      await screen.findByRole("button", { name: /Add calendar server/ }),
    );
    const setup = await dialog("Add calendar server");
    await user.type(within(setup).getByLabelText("Name"), "Home");
    await user.type(
      within(setup).getByLabelText("Server address"),
      "dav.example.com",
    );
    await user.type(within(setup).getByLabelText("User name"), "me");
    await user.type(within(setup).getByLabelText("Password"), "wrong");
    await user.click(within(setup).getByRole("button", { name: "Connect" }));
    expect(await within(setup).findByRole("alert")).toHaveTextContent(
      "The server refused the login.",
    );
    expect(dav.connected[0]).toMatchObject({
      label: "Home",
      urls: ["https://dav.example.com"],
      login: { username: "me", password: "wrong" },
    });
    await user.clear(within(setup).getByLabelText("Password"));
    await user.type(within(setup).getByLabelText("Password"), "secret");
    await user.click(within(setup).getByRole("button", { name: "Connect" }));
    expect(await toastText("Calendars of Home are shown")).toBeInTheDocument();
    const section = await screen.findByRole("region", { name: "Home" });
    expect(
      within(section).getByText("Calendar server (CalDAV)"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Team lunch/ }),
    ).toBeInTheDocument();

    await user.click(
      within(section).getByRole("button", {
        name: "Calendar server of Home",
      }),
    );
    const edit = await dialog("Calendar server: Home");
    await user.click(within(edit).getByRole("button", { name: "Remove" }));
    const question = await screen.findByRole("alertdialog", {
      name: "Remove Home?",
    });
    await user.click(within(question).getByRole("button", { name: "Remove" }));
    expect(await toastText("Removed Home")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Home" }),
      ).not.toBeInTheDocument();
    });
  });

  it("are for the apps only", async () => {
    renderApp({ hash: WEEK });
    const add = await screen.findByRole("button", {
      name: /Add calendar server/,
    });
    expect(add).toBeDisabled();
    expect(
      screen.getByText(
        "Calendar servers (CalDAV) work in the desktop and Android apps.",
      ),
    ).toBeInTheDocument();
  });
});
