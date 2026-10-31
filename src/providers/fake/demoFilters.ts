import { asFilterId, NO_ACTIONS, NO_CONDITIONS } from "../../core/filters";
import { DEMO_MAILBOX } from "./demoData";
import { WORK_MAILBOX } from "./demoWork";
import type { FakeFilterData } from "./FakeFilterProvider";

/** The demo account's filters, Gmail-style. */
export function createDemoFilters(): FakeFilterData {
  return {
    flavor: "gmail",
    filters: [
      {
        id: asFilterId("demo-receipts"),
        enabled: true,
        conditions: { ...NO_CONDITIONS, from: ["billing@shop.example"] },
        actions: {
          ...NO_ACTIONS,
          skipInbox: true,
          labels: [DEMO_MAILBOX.receipts],
        },
        more: false,
      },
      {
        id: asFilterId("demo-hiking"),
        enabled: true,
        conditions: {
          ...NO_CONDITIONS,
          from: ["news@hiking-club.example", "digest@news.example"],
        },
        actions: { ...NO_ACTIONS, markRead: true },
        // Like Gmail's "Categorize as: Updates", which action0 keeps.
        more: true,
      },
    ],
    autoReply: {
      enabled: false,
      subject: "Out of office",
      text: "<p>Thanks for your mail. I’m away and will answer when I’m back.</p>",
      contactsOnly: false,
    },
    forwardAddresses: ["demo.backup@example.net"],
  };
}

/** The work demo account's rules, Outlook-style. */
export function createWorkDemoFilters(): FakeFilterData {
  return {
    flavor: "outlook",
    filters: [
      {
        id: asFilterId("work-website"),
        name: "Website notifications",
        enabled: true,
        conditions: { ...NO_CONDITIONS, subject: ["[website]"] },
        actions: {
          ...NO_ACTIONS,
          moveTo: WORK_MAILBOX.website,
          stop: true,
        },
        more: false,
      },
      {
        id: asFilterId("work-team"),
        name: "Team mail",
        enabled: false,
        conditions: { ...NO_CONDITIONS, to: ["team@work.example"] },
        actions: { ...NO_ACTIONS, labels: [WORK_MAILBOX.team] },
        more: false,
      },
    ],
    autoReply: {
      enabled: false,
      subject: "",
      text: "<p>I’m out of the office and will reply when I’m back.</p>",
      contactsOnly: false,
      outside: {
        audience: "contacts",
        text: "<p>Thanks for your mail. I’m out of the office and will reply when I’m back.</p>",
      },
    },
  };
}
