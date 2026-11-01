import { describe, expect, it } from "vitest";
import {
  formatSendAtMarker,
  isDue,
  isMissed,
  parseSendAtMarker,
  sendLaterPresets,
} from "./schedule";

const at = (text: string) => new Date(text);

describe("the Send later marker", () => {
  it("keeps the time and who scheduled it", () => {
    const value = formatSendAtMarker({
      sendAt: at("2026-11-03T07:00:00Z"),
      by: "abc123",
    });
    expect(value).toBe("2026-11-03T07:00:00.000Z; by=abc123");
    expect(parseSendAtMarker(value)).toEqual({
      sendAt: "2026-11-03T07:00:00.000Z",
      by: "abc123",
    });
  });

  it("reads a bare time (Exchange's deferred time), and nothing else", () => {
    expect(parseSendAtMarker("2026-11-03T07:00:00Z")).toEqual({
      sendAt: "2026-11-03T07:00:00.000Z",
    });
    expect(parseSendAtMarker("")).toBeUndefined();
    expect(parseSendAtMarker("soon")).toBeUndefined();
    expect(parseSendAtMarker(undefined)).toBeUndefined();
  });
});

describe("when scheduled mail goes out", () => {
  const sendAt = "2026-11-03T07:00:00.000Z";
  const time = Date.parse(sendAt);

  it("is sent by the action0 that scheduled it at its time, by others a little later", () => {
    const mine = { sendAt, scheduledBy: "me" };
    expect(isDue(mine, time - 1, "me")).toBe(false);
    expect(isDue(mine, time, "me")).toBe(true);
    expect(isDue(mine, time, "other")).toBe(false);
    expect(isDue(mine, time + 2 * 60_000, "other")).toBe(true);
    // Unknown: anyone.
    expect(isDue({ sendAt }, time, "other")).toBe(true);
  });

  it("isn't sent unasked more than 30 minutes late", () => {
    expect(isMissed(sendAt, time + 30 * 60_000)).toBe(false);
    expect(isMissed(sendAt, time + 30 * 60_000 + 1)).toBe(true);
    expect(isDue({ sendAt }, time + 31 * 60_000, "me")).toBe(false);
  });
});

describe("the times offered", () => {
  const kinds = (now: Date) => sendLaterPresets(now).map((p) => p.kind);

  it("offers this afternoon in the morning, then tomorrow", () => {
    // Tuesday morning.
    const morning = new Date(2026, 10, 3, 9, 30);
    expect(kinds(morning)).toEqual([
      "this-afternoon",
      "tomorrow-morning",
      "tomorrow-afternoon",
    ]);
    const [afternoon, tomorrow] = sendLaterPresets(morning);
    expect(afternoon?.at).toEqual(new Date(2026, 10, 3, 13, 0));
    expect(tomorrow?.at).toEqual(new Date(2026, 10, 4, 8, 0));
    expect(kinds(new Date(2026, 10, 3, 15, 0))).toEqual([
      "tomorrow-morning",
      "tomorrow-afternoon",
    ]);
  });

  it("offers Monday morning on Fridays and Saturdays", () => {
    const friday = new Date(2026, 10, 6, 16, 0);
    const presets = sendLaterPresets(friday);
    expect(presets.map((p) => p.kind)).toContain("monday-morning");
    expect(presets.at(-1)?.at).toEqual(new Date(2026, 10, 9, 8, 0));
    const saturday = new Date(2026, 10, 7, 16, 0);
    expect(sendLaterPresets(saturday).at(-1)?.at).toEqual(
      new Date(2026, 10, 9, 8, 0),
    );
    // Sunday: tomorrow is Monday already.
    expect(kinds(new Date(2026, 10, 8, 16, 0))).not.toContain("monday-morning");
  });
});
