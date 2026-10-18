import { describe, expect, it } from "vitest";
import {
  formatBinding,
  normalizeStroke,
  parseBinding,
  strokeFromEvent,
} from "./keys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("strokeFromEvent", () => {
  it("matches printable characters by the character they produce", () => {
    expect(strokeFromEvent(key({ key: "j" }))).toBe("j");
    expect(strokeFromEvent(key({ key: "J", shiftKey: true }))).toBe("J");
    // '?' is Shift+ß on German keyboards and Shift+/ on US ones.
    expect(strokeFromEvent(key({ key: "?", shiftKey: true }))).toBe("?");
  });

  it("ignores Caps Lock for letters", () => {
    expect(strokeFromEvent(key({ key: "J" }))).toBe("j");
  });

  it("spells out modifiers for named keys", () => {
    expect(strokeFromEvent(key({ key: "ArrowDown", shiftKey: true }))).toBe(
      "shift+ArrowDown",
    );
    expect(strokeFromEvent(key({ key: " " }))).toBe("Space");
    expect(strokeFromEvent(key({ key: "a", ctrlKey: true }))).toBe("ctrl+a");
  });

  it("ignores bare modifier presses", () => {
    expect(
      strokeFromEvent(key({ key: "Shift", shiftKey: true })),
    ).toBeUndefined();
  });
});

describe("bindings", () => {
  it("normalizes strokes", () => {
    expect(normalizeStroke("shift+j")).toBe("J");
    expect(normalizeStroke("Shift+ArrowUp")).toBe("shift+ArrowUp");
    expect(normalizeStroke("shift+space")).toBe("shift+Space");
    expect(normalizeStroke("Esc")).toBe("Escape");
    expect(normalizeStroke("meta+ctrl+k")).toBe("ctrl+meta+k");
  });

  it("parses sequences", () => {
    expect(parseBinding("g i")).toEqual(["g", "i"]);
  });

  it("formats bindings for people", () => {
    expect(formatBinding("shift+j")).toBe("Shift+j");
    expect(formatBinding("g i")).toBe("g then i");
    expect(formatBinding("ArrowDown")).toBe("↓");
  });
});
