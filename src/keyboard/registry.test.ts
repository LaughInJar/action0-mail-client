import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry, SEQUENCE_TIMEOUT_MS, type Command } from "./registry";

const press = (
  registry: CommandRegistry,
  init: KeyboardEventInit,
  target?: Element,
) => {
  const event = new KeyboardEvent("keydown", {
    ...init,
    cancelable: true,
    bubbles: true,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  const handled = registry.handleKeyDown(event);
  return { handled, prevented: event.defaultPrevented };
};

function command(id: string, keys: string[], extra: Partial<Command> = {}) {
  const run = vi.fn();
  return {
    id,
    group: "general" as const,
    description: id,
    keys,
    run,
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandRegistry", () => {
  it("runs matching commands and prevents the default action", () => {
    const registry = new CommandRegistry();
    const next = command("next", ["j", "ArrowDown"]);
    registry.register([next]);
    expect(press(registry, { key: "j" })).toEqual({
      handled: true,
      prevented: true,
    });
    expect(press(registry, { key: "ArrowDown" }).handled).toBe(true);
    expect(next.run).toHaveBeenCalledTimes(2);
    expect(press(registry, { key: "k" })).toEqual({
      handled: false,
      prevented: false,
    });
  });

  it("supports sequences with a timeout", () => {
    vi.useFakeTimers();
    const registry = new CommandRegistry();
    const inbox = command("inbox", ["g i"]);
    registry.register([inbox]);

    expect(press(registry, { key: "g" }).handled).toBe(true);
    press(registry, { key: "i" });
    expect(inbox.run).toHaveBeenCalledTimes(1);

    press(registry, { key: "g" });
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);
    press(registry, { key: "i" });
    expect(inbox.run).toHaveBeenCalledTimes(1);
  });

  it("falls back to the single stroke when a sequence doesn't continue", () => {
    const registry = new CommandRegistry();
    const inbox = command("inbox", ["g i"]);
    const next = command("next", ["j"]);
    registry.register([inbox, next]);
    press(registry, { key: "g" });
    press(registry, { key: "j" });
    expect(next.run).toHaveBeenCalledTimes(1);
  });

  it("respects `when` and lets the latest registration win", () => {
    const registry = new CommandRegistry();
    const clear = command("clear", ["Escape"], { when: () => false });
    const close = command("close", ["Escape"]);
    registry.register([close]);
    const unregister = registry.register([clear]);
    press(registry, { key: "Escape" });
    expect(close.run).toHaveBeenCalledTimes(1);
    expect(clear.run).not.toHaveBeenCalled();

    unregister();
    expect(registry.list().map((c) => c.id)).toEqual(["close"]);
  });

  it("stays out of text fields and lets buttons keep Space and Enter", () => {
    const registry = new CommandRegistry();
    const next = command("next", ["j"]);
    const scroll = command("scroll", ["Space"]);
    registry.register([next, scroll]);

    expect(
      press(registry, { key: "j" }, document.createElement("input")).handled,
    ).toBe(false);
    expect(
      press(registry, { key: "j" }, document.createElement("textarea")).handled,
    ).toBe(false);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(press(registry, { key: "j" }, checkbox).handled).toBe(true);

    expect(
      press(registry, { key: " " }, document.createElement("button")).handled,
    ).toBe(false);
    expect(
      press(registry, { key: " " }, document.createElement("div")).handled,
    ).toBe(true);
  });

  it("ignores events that were already handled", () => {
    const registry = new CommandRegistry();
    const next = command("next", ["j"]);
    registry.register([next]);
    const event = new KeyboardEvent("keydown", { key: "j", cancelable: true });
    event.preventDefault();
    expect(registry.handleKeyDown(event)).toBe(false);
  });
});
