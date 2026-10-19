// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { MemoryStorage } from "../test/memoryStorage";
import {
  createMicrosoftSetup,
  MICROSOFT_CLIENT_ID_KEY,
  storedMicrosoftClientId,
  validateMicrosoftClientId,
} from "./microsoftSetup";

const ID = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

describe("validateMicrosoftClientId", () => {
  it.each([
    ["", "missing"],
    ["Abc8Q~xYz.secretvalue", "secret"],
    ["https://entra.microsoft.com/", "url"],
    ["action0", "malformed"],
    [` ${ID} `, undefined],
  ])("%j → %s", (value, problem) => {
    expect(validateMicrosoftClientId(value)).toBe(problem);
  });
});

describe("createMicrosoftSetup", () => {
  it("stores a valid ID in this browser and registers Microsoft", () => {
    const settings = new MemoryStorage();
    const registry = new AccountRegistry({ modules: [], storage: settings });
    const setup = createMicrosoftSetup({
      registry,
      buildClientId: undefined,
      settings,
      sessionStorage: undefined,
    });
    expect(setup.current()).toBeUndefined();
    setup.apply("not an id");
    expect(registry.hasModule("microsoft")).toBe(false);
    setup.apply(` ${ID} `);
    expect(registry.hasModule("microsoft")).toBe(true);
    expect(setup.current()).toEqual({ value: ID, source: "browser" });
    expect(storedMicrosoftClientId(settings)).toBe(ID);
    expect(settings.getItem(MICROSOFT_CLIENT_ID_KEY)).toContain(ID);
  });

  it("prefers the ID from the build", () => {
    const settings = new MemoryStorage();
    const setup = createMicrosoftSetup({
      registry: new AccountRegistry({ modules: [], storage: settings }),
      buildClientId: ID,
      settings,
      sessionStorage: undefined,
    });
    expect(setup.current()).toEqual({ value: ID, source: "build" });
  });
});
