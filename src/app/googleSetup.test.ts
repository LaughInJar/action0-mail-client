// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { MemoryStorage } from "../test/memoryStorage";
import {
  createGoogleDesktopSetup,
  createGoogleSetup,
  GOOGLE_CLIENT_ID_KEY,
  GOOGLE_DESKTOP_CLIENT_KEY,
  storedGoogleClientId,
  storedGoogleDesktopClient,
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

describe("the desktop app's Google setup", () => {
  const SECRET = "GOCSPX-a1b2c3d4e5f6";

  function setup(buildClient?: { id: string; secret: string }) {
    const settings = new MemoryStorage();
    const registry = new AccountRegistry({ modules: [], storage: undefined });
    const google = createGoogleDesktopSetup({
      registry,
      buildClient,
      settings,
      native: {
        bridge: {
          connect: () => Promise.reject(new Error("unused")),
          signIn: () => Promise.reject(new Error("unused")),
          token: () => Promise.reject(new Error("unused")),
          signOut: () => Promise.resolve(),
        },
        accounts: new Map(),
      },
      fetch: () => Promise.reject(new Error("unused")),
    });
    return { settings, registry, google };
  }

  it("needs the client secret too, and keeps both in the app's settings", () => {
    const { settings, registry, google } = setup();
    expect(google.secret?.validate("")).toBe("missing");
    expect(google.secret?.validate(VALID)).toBe("malformed");
    expect(google.secret?.validate(SECRET)).toBeUndefined();

    google.apply(VALID);
    expect(registry.hasModule("gmail")).toBe(false);
    google.apply(` ${VALID}`, ` ${SECRET} `);
    expect(registry.hasModule("gmail")).toBe(true);
    expect(google.current()).toEqual({
      value: VALID,
      secret: SECRET,
      source: "browser",
    });
    expect(storedGoogleDesktopClient(settings)).toEqual({
      id: VALID,
      secret: SECRET,
    });
    expect(settings.getItem(GOOGLE_DESKTOP_CLIENT_KEY)).not.toBeNull();
  });

  it("lets the build setting win", () => {
    const { google } = setup({ id: VALID, secret: SECRET });
    expect(google.current()).toEqual({
      value: VALID,
      secret: SECRET,
      source: "build",
    });
  });
});
