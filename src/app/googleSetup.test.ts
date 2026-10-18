// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { MemoryStorage } from "../test/memoryStorage";
import {
  createGoogleSetup,
  GOOGLE_CLIENT_ID_KEY,
  storedGoogleClientId,
  validateGoogleClientId,
} from "./googleSetup";

const VALID = "424727749781-abcdef.apps.googleusercontent.com";

describe("validateGoogleClientId", () => {
  it("accepts client IDs, with surrounding whitespace", () => {
    expect(validateGoogleClientId(VALID)).toBeUndefined();
    expect(validateGoogleClientId(`  ${VALID}\n`)).toBeUndefined();
  });

  it.each([
    ["", "missing"],
    ["GOCSPX-abc123", "secret"],
    ["https://console.cloud.google.com/auth/clients", "url"],
    ["424727749781", "malformed"],
  ])("says what's wrong with %j", (value, problem) => {
    expect(validateGoogleClientId(value)).toBe(problem);
  });
});

describe("createGoogleSetup", () => {
  function setup(buildClientId?: string) {
    const settings = new MemoryStorage();
    const registry = new AccountRegistry({ modules: [], storage: undefined });
    const google = createGoogleSetup({
      registry,
      buildClientId,
      settings,
      tokenStorage: undefined,
    });
    return { settings, registry, google };
  }

  it("stores the client ID in the browser and registers Gmail", () => {
    const { settings, registry, google } = setup();
    expect(google.current()).toBeUndefined();
    expect(registry.hasModule("gmail")).toBe(false);

    google.apply(`  ${VALID} `);
    expect(registry.hasModule("gmail")).toBe(true);
    expect(google.current()).toEqual({ value: VALID, source: "browser" });
    expect(storedGoogleClientId(settings)).toBe(VALID);
    expect(settings.getItem(GOOGLE_CLIENT_ID_KEY)).toBe(JSON.stringify(VALID));
  });

  it("ignores invalid values", () => {
    const { registry, google } = setup();
    google.apply("GOCSPX-oops");
    expect(registry.hasModule("gmail")).toBe(false);
    expect(google.current()).toBeUndefined();
  });

  it("lets the build setting win", () => {
    const { google } = setup("1-build.apps.googleusercontent.com");
    expect(google.current()).toEqual({
      value: "1-build.apps.googleusercontent.com",
      source: "build",
    });
  });

  it("ignores a stored value that isn't a client ID", () => {
    const settings = new MemoryStorage();
    settings.setItem(GOOGLE_CLIENT_ID_KEY, JSON.stringify("nonsense"));
    expect(storedGoogleClientId(settings)).toBeUndefined();
  });
});
