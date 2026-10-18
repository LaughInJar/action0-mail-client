// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMailError } from "../../core/errors";
import { MemoryStorage } from "../../test/memoryStorage";
import type { GoogleOAuth2 } from "./gis";
import { GoogleAuthSession } from "./GoogleAuthSession";
import { sessionTokenStore } from "./tokenStore";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const NOW = 1_000_000;

type Outcome =
  | { kind: "token"; scope?: string; expiresIn?: number }
  | {
      kind: "error";
      type: "popup_closed" | "popup_failed_to_open" | "unknown";
    };

/** A scriptable stand-in for `google.accounts.oauth2`. */
function fakeGis(outcomes: Outcome[]) {
  const requests: Record<string, unknown>[] = [];
  /** The scope of each token request. */
  const scopes: string[] = [];
  const revoked: string[] = [];
  let issued = 0;
  const oauth2 = {
    initTokenClient: (config: google.accounts.oauth2.TokenClientConfig) => ({
      requestAccessToken: (
        override: google.accounts.oauth2.OverridableTokenClientConfig = {},
      ) => {
        requests.push({ ...override });
        scopes.push(config.scope);
        const outcome = outcomes.shift() ?? { kind: "token" };
        queueMicrotask(() => {
          if (outcome.kind === "error") {
            config.error_callback?.({
              type: outcome.type,
              message: outcome.type,
              name: "Error",
            });
            return;
          }
          issued++;
          config.callback({
            access_token: `token-${issued}`,
            expires_in: String(outcome.expiresIn ?? 3599),
            scope: outcome.scope ?? SCOPE,
          } as google.accounts.oauth2.TokenResponse);
        });
      },
    }),
    hasGrantedAllScopes: (
      response: google.accounts.oauth2.TokenResponse,
      ...scopes: string[]
    ) => scopes.every((scope) => response.scope.split(" ").includes(scope)),
    revoke: (token: string, done: () => void) => {
      revoked.push(token);
      done();
    },
  } as unknown as GoogleOAuth2;
  return { oauth2, requests, scopes, revoked };
}

function setup(
  outcomes: Outcome[] = [],
  storage = new MemoryStorage(),
  optionalScope?: string,
) {
  const gis = fakeGis(outcomes);
  const session = new GoogleAuthSession({
    clientId: "client-id",
    scope: SCOPE,
    ...(optionalScope ? { optionalScope } : {}),
    loginHint: "jane@example.com",
    tokenStore: sessionTokenStore("gmail:jane@example.com", storage),
    now: () => NOW,
    gis: { peek: () => gis.oauth2, load: () => Promise.resolve(gis.oauth2) },
  });
  return { session, storage, ...gis };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GoogleAuthSession", () => {
  it("starts expired without a stored token and never opens UI on its own", async () => {
    const { session, requests } = setup();
    expect(session.status).toBe("expired");
    const error: unknown = await session
      .getAccessToken()
      .catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(requests).toEqual([]);
  });

  it("signs in silently with the login hint and stores the token in the given (session) storage", async () => {
    const { session, storage, requests } = setup();
    await session.signIn();
    expect(requests).toEqual([{ prompt: "", login_hint: "jane@example.com" }]);
    expect(session.status).toBe("signed-in");
    expect(session.expiresAt).toBe(NOW + 3599 * 1000);
    await expect(session.getAccessToken()).resolves.toBe("token-1");
    expect(storage.dump()).toContain("token-1");
  });

  it("restores a still-valid token after a reload", async () => {
    const storage = new MemoryStorage();
    await setup([], storage).session.signIn();
    const { session, requests } = setup([], storage);
    expect(session.status).toBe("signed-in");
    await expect(session.getAccessToken()).resolves.toBe("token-1");
    expect(requests).toEqual([]);
  });

  it("shares one popup between concurrent sign-in calls", async () => {
    const { session, requests } = setup();
    await Promise.all([session.signIn(), session.signIn()]);
    expect(requests).toHaveLength(1);
  });

  it("rejects when the Gmail scope was not granted", async () => {
    const { session } = setup([{ kind: "token", scope: "openid" }]);
    const error: unknown = await session.signIn().catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(session.status).toBe("expired");
  });

  it("explains a blocked popup", async () => {
    const { session } = setup([
      { kind: "error", type: "popup_failed_to_open" },
    ]);
    await expect(session.signIn()).rejects.toThrow(/blocked/);
  });

  it("expires when the token runs out and when the API rejects it", async () => {
    vi.useFakeTimers();
    const { session, storage } = setup([{ kind: "token", expiresIn: 120 }]);
    await session.signIn();
    const listener = vi.fn();
    session.subscribe(listener);
    vi.advanceTimersByTime(60_000);
    expect(session.status).toBe("expired");
    expect(listener).toHaveBeenCalled();
    expect(storage.length).toBe(0);

    await session.signIn();
    session.markExpired();
    expect(session.status).toBe("expired");
  });

  it("revokes the token on sign-out", async () => {
    const { session, storage, revoked } = setup();
    await session.signIn();
    await session.signOut();
    expect(revoked).toEqual(["token-1"]);
    expect(session.status).toBe("signed-out");
    expect(storage.length).toBe(0);
  });

  it("treats stored tokens without the required scope as expired", () => {
    const storage = new MemoryStorage();
    const store = sessionTokenStore("gmail:jane@example.com", storage);
    // A token from before scopes were recorded, and one with a narrower scope.
    storage.setItem(
      "a0.token.gmail:jane@example.com",
      JSON.stringify({ accessToken: "old", expiresAt: NOW + 3_000_000 }),
    );
    expect(setup([], storage).session.status).toBe("expired");
    store.save({
      accessToken: "readonly",
      expiresAt: NOW + 3_000_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    expect(setup([], storage).session.status).toBe("expired");
    store.save({
      accessToken: "ok",
      expiresAt: NOW + 3_000_000,
      scope: `openid ${SCOPE}`,
    });
    expect(setup([], storage).session.status).toBe("signed-in");
  });

  it("stores the granted scopes with the token", async () => {
    const { session, storage } = setup();
    await session.signIn();
    expect(storage.dump()).toContain(SCOPE);
  });

  describe("optional scopes", () => {
    const CONTACTS = "contacts.readonly contacts.other.readonly";

    it("asks for them too, but signs in without them", async () => {
      const { session, scopes } = setup(
        [{ kind: "token", scope: SCOPE }],
        new MemoryStorage(),
        CONTACTS,
      );
      await session.signIn();
      expect(scopes[0]).toBe(`${SCOPE} ${CONTACTS}`);
      expect(session.status).toBe("signed-in");
    });

    it("needs one reconnect for tokens that were never asked for them", () => {
      const storage = new MemoryStorage();
      const store = sessionTokenStore("gmail:jane@example.com", storage);
      store.save({
        accessToken: "old",
        expiresAt: NOW + 3_000_000,
        scope: SCOPE,
      });
      expect(setup([], storage, CONTACTS).session.status).toBe("expired");
      // Asked, but declined: fine.
      store.save({
        accessToken: "declined",
        expiresAt: NOW + 3_000_000,
        scope: SCOPE,
        requested: `${SCOPE} ${CONTACTS}`,
      });
      expect(setup([], storage, CONTACTS).session.status).toBe("signed-in");
    });

    it("doesn't ask again for a declined scope", async () => {
      const { session, scopes } = setup(
        [
          { kind: "token", scope: SCOPE },
          { kind: "token", scope: SCOPE },
        ],
        new MemoryStorage(),
        CONTACTS,
      );
      await session.signIn();
      session.markExpired();
      await session.signIn();
      expect(scopes[1]).toBe(SCOPE);
    });

    it("asks again for declined scopes when the user wants to", async () => {
      const { session, scopes } = setup(
        [
          { kind: "token", scope: SCOPE },
          { kind: "token", scope: `${SCOPE} ${CONTACTS}` },
        ],
        new MemoryStorage(),
        CONTACTS,
      );
      await session.signIn();
      await session.signIn({ askAgain: true });
      expect(scopes[1]).toBe(`${SCOPE} ${CONTACTS}`);
    });
  });
});
