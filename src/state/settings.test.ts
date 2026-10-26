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
