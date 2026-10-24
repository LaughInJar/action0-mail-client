import { describe, expect, it, vi } from "vitest";
import { isMailError } from "../../core/errors";
import {
  NativeAuthError,
  type NativeAuthBridge,
  type NativeSignInRequest,
} from "./bridge";
import { connectNative, NativeAuthSession } from "./NativeAuthSession";

const CALENDAR = ["https://graph.microsoft.com/Calendars.ReadWrite"];

function setup(bridge: Partial<NativeAuthBridge> = {}) {
  const full: NativeAuthBridge = {
    connect: vi.fn(),
    signIn: vi.fn((key: string, request: NativeSignInRequest) =>
      Promise.resolve({
        key,
        email: "max@contoso.com",
        scopes: request.scopes,
      }),
    ),
    token: vi.fn(() =>
      Promise.resolve({
        accessToken: "at-1",
        expiresAt: Date.now() + 3_600_000,
      }),
    ),
    signOut: vi.fn(() => Promise.resolve()),
    ...bridge,
  };
  const session = new NativeAuthSession({
    bridge: full,
    provider: "microsoft",
    client: { id: "client" },
    key: "microsoft:max@contoso.com",
    loginHint: "max@contoso.com",
    scopes: ["Mail.ReadWrite", "offline_access"],
    required: ["Mail.ReadWrite"],
    granted: ["Mail.ReadWrite", "offline_access"],
    providerName: "Microsoft",
  });
  return { session, bridge: full };
}

describe("NativeAuthSession", () => {
  it("gets access tokens from the native side and renews silently", async () => {
    const { session, bridge } = setup();
    expect(session.status).toBe("signed-in");
    // Nothing to do on clicks: the native side renews.
    expect(session.expiresAt).toBeUndefined();
    expect(await session.getAccessToken()).toBe("at-1");
    expect(bridge.token).toHaveBeenCalledWith("microsoft:max@contoso.com", []);
  });

  it("expires when the provider wants a new sign-in, and signs in again", async () => {
    const { session } = setup({
      token: () => Promise.reject(new NativeAuthError("reauth", "revoked")),
    });
    const listener = vi.fn();
    session.subscribe(listener);
    const error = await session.getAccessToken().catch((e: unknown) => e);
    expect(isMailError(error, "auth-required") && error.reason).toBe(
      "signInAgain",
    );
    expect(session.status).toBe("expired");
    expect(listener).toHaveBeenCalled();
    await session.signIn();
    expect(session.status).toBe("signed-in");
  });

  it("knows its scopes, and asks for more with consent", async () => {
    const { session, bridge } = setup({
      token: () =>
        Promise.reject(new NativeAuthError("scopes", "Calendars.ReadWrite")),
    });
    expect(session.hasScopes(["mail.readwrite"])).toBe(true);
    expect(session.hasScopes(CALENDAR)).toBe(false);
    // Without calendar access mail goes on; the calendar is "unavailable".
    const error = await session.tokenFor(CALENDAR).catch((e: unknown) => e);
    expect(isMailError(error, "unavailable") && error.reason).toBe(
      "calendarAccessNeeded",
    );
    expect(session.status).toBe("signed-in");

    await session.requestScopes(CALENDAR);
    expect(bridge.signIn).toHaveBeenCalledWith(
      "microsoft:max@contoso.com",
      expect.objectContaining({
        prompt: "consent",
        scopes: expect.arrayContaining(CALENDAR) as unknown,
      }),
    );
    expect(session.hasScopes(CALENDAR)).toBe(true);
  });

  it("shares one browser sign-in between callers", async () => {
    const { session, bridge } = setup();
    await Promise.all([session.signIn(), session.signIn()]);
    expect(bridge.signIn).toHaveBeenCalledTimes(1);
  });

  it("explains refused sign-ins", async () => {
    const { session } = setup({
      signIn: () =>
        Promise.reject(new NativeAuthError("wrongAccount", "anna@contoso.com")),
    });
    const error = await session.signIn().catch((e: unknown) => e);
    expect(isMailError(error) && error.reason).toBe("wrongAccount");
    expect(isMailError(error) && error.params).toMatchObject({
      actual: "anna@contoso.com",
      expected: "max@contoso.com",
    });
    const denied = await connectNative(
      {
        ...setup().bridge,
        connect: () =>
          Promise.reject(new NativeAuthError("cancelled", "timed out")),
      },
      {
        provider: "google",
        client: { id: "c" },
        scopes: [],
        required: [],
        prompt: "select_account",
      },
      "Google",
    ).catch((e: unknown) => e);
    expect(isMailError(denied, "auth-required") && denied.reason).toBe(
      "signInClosed",
    );
    const noPlay = await connectNative(
      {
        ...setup().bridge,
        connect: () =>
          Promise.reject(new NativeAuthError("noPlayServices", "missing")),
      },
      {
        provider: "google",
        client: { id: "play-services" },
        scopes: [],
        required: [],
        prompt: "select_account",
      },
      "Google",
    ).catch((e: unknown) => e);
    expect(isMailError(noPlay, "unavailable") && noPlay.reason).toBe(
      "noPlayServices",
    );
  });

  it("signs out natively", async () => {
    const { session, bridge } = setup();
    await session.signOut();
    expect(bridge.signOut).toHaveBeenCalledWith("microsoft:max@contoso.com");
    expect(session.status).toBe("signed-out");
  });
});
