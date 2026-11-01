// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadsRemoteImages,
  markReadDelayMs,
  MAX_TRUSTED_SENDERS,
  parseSettings,
} from "./settings";

describe("parseSettings", () => {
  it("fills in defaults for missing, invalid or foreign values", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(
      parseSettings({
        density: "compact",
        afterRemove: "sideways",
        markRead: "manual",
        remoteImages: "always",
        undoSendSeconds: 7,
        notifications: "yes",
        trustedSenders: ["anna@example.org", 3, "not an address"],
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      density: "compact",
      markRead: "manual",
      remoteImages: "always",
      trustedSenders: ["anna@example.org"],
    });
  });

  it("keeps spelling languages that are language tags", () => {
    expect(
      parseSettings({
        spellcheck: false,
        spellLanguages: ["de-AT", "en", "de_AT", "<b>", 7],
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      spellcheck: false,
      spellLanguages: ["de-AT", "en"],
    });
    expect(parseSettings({ spellLanguages: "de-AT" }).spellLanguages).toEqual(
      [],
    );
  });

  it("keeps AI services of known kinds, never keys, and valid choices", () => {
    expect(
      parseSettings({
        aiServices: [
          { id: "a", kind: "anthropic", key: "sk-secret", remember: true },
          { id: "b", kind: "copilot" },
          {
            id: "c",
            kind: "compatible",
            name: "Work",
            baseUrl: "javascript:x",
          },
          { id: "d", kind: "chatgpt", account: "me@example.com" },
        ],
        aiChoices: {
          reader: { service: "a", model: "claude-haiku-5-5" },
          composer: { service: "a" },
        },
        aiNoticed: ["a", 3],
      }),
    ).toMatchObject({
      aiServices: [
        { id: "a", kind: "anthropic", remember: true },
        { id: "c", kind: "compatible", name: "Work" },
        { id: "d", kind: "chatgpt", account: "me@example.com" },
      ],
      aiChoices: { reader: { service: "a", model: "claude-haiku-5-5" } },
      aiNoticed: ["a"],
    });
  });

  it("keeps the newest trusted senders when there are too many", () => {
    const many = Array.from(
      { length: MAX_TRUSTED_SENDERS + 2 },
      (_, i) => `s${i}@example.org`,
    );
    const { trustedSenders } = parseSettings({ trustedSenders: many });
    expect(trustedSenders).toHaveLength(MAX_TRUSTED_SENDERS);
    expect(trustedSenders[0]).toBe("s2@example.org");
  });
});

describe("setting helpers", () => {
  it("turns mark-as-read into a delay", () => {
    expect(markReadDelayMs("immediately")).toBe(0);
    expect(markReadDelayMs("delay")).toBe(1500);
    expect(markReadDelayMs("manual")).toBeNull();
  });

  it("loads remote images always, or for trusted senders only in that mode", () => {
    const trusted = ["anna@example.org"];
    const load = (mode: "ask" | "always" | "trusted", sender?: string) =>
      loadsRemoteImages(
        { remoteImages: mode, trustedSenders: trusted },
        sender,
      );
    expect(load("always")).toBe(true);
    expect(load("trusted", "Anna@Example.org")).toBe(true);
    expect(load("trusted", "bob@example.org")).toBe(false);
    expect(load("ask", "anna@example.org")).toBe(false);
  });
});

describe("templates in the settings", () => {
  it("keeps valid templates and drops broken ones", () => {
    const settings = parseSettings({
      templates: [
        { id: "1", name: "Thanks", subject: "", html: "<p>Thanks</p>" },
        {
          id: "2",
          name: "Offer",
          subject: "Offer",
          html: "<p>Offer</p>",
          accountId: "demo:demo@work.example",
        },
        { id: "3", name: "Broken" },
        "nonsense",
      ],
    });
    expect(settings.templates.map((template) => template.id)).toEqual([
      "1",
      "2",
    ]);
    expect(settings.templates[1]?.accountId).toBe("demo:demo@work.example");
    expect(parseSettings({ templates: "x" }).templates).toEqual([]);
  });

  it("keeps the command palette's recent ids, at most ten", () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `place:${String(index)}`,
    );
    expect(parseSettings({ paletteRecent: [...ids, 7] }).paletteRecent).toEqual(
      ids.slice(0, 10),
    );
    expect(parseSettings({ paletteRecent: "x" }).paletteRecent).toEqual([]);
  });

  it("keeps a valid device id and last Send later time", () => {
    expect(
      parseSettings({
        deviceId: "a1b2c3",
        lastSendLater: "2026-11-03T07:00:00.000Z",
      }),
    ).toMatchObject({
      deviceId: "a1b2c3",
      lastSendLater: "2026-11-03T07:00:00.000Z",
    });
    expect(
      parseSettings({ deviceId: "no spaces!", lastSendLater: "soon" }),
    ).toMatchObject({ deviceId: "", lastSendLater: "" });
  });
});
