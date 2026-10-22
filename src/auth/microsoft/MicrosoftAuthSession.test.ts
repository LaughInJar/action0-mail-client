// @vitest-environment node
import type { AccountInfo, AuthenticationResult } from "@azure/msal-browser";
import { describe, expect, it, vi } from "vitest";
import { isMailError } from "../../core/errors";
import { MemoryStorage } from "../../test/memoryStorage";
import {
  MicrosoftAuthSession,
  sessionAccountStore,
} from "./MicrosoftAuthSession";
import type { MsalClient } from "./msal";

const account = (username: string, home = `home-${username}`): AccountInfo => ({
  homeAccountId: home,
  environment: "login.microsoftonline.com",
  tenantId: "tenant",
  username,
  localAccountId: "local",
});

const result = (who: AccountInfo, token = "token-1"): AuthenticationResult =>
  ({
    accessToken: token,
    account: who,
    expiresOn: new Date(Date.now() + 3_600_000),
  }) as AuthenticationResult;

/** MSAL errors are checked by shape. */
const msalError = (errorCode: string, errorMessage = "", name = "AuthError") =>
  Object.assign(new Error(errorMessage), { name, errorCode, errorMessage });

function setup(client: Partial<MsalClient>, loginHint = "max@contoso.com") {
  const msal: MsalClient = {
    acquireTokenSilent: vi.fn(() => Promise.reject(new Error("unexpected"))),
    ssoSilent: vi.fn(() => Promise.reject(new Error("unexpected"))),
    acquireTokenPopup: vi.fn(() => Promise.reject(new Error("unexpected"))),
    getAllAccounts: vi.fn(() => []),
    clearCache: vi.fn(() => Promise.resolve()),
    ...client,
  };
  const storage = new MemoryStorage();
  const session = new MicrosoftAuthSession({
    loginHint,
    msal: { peek: () => msal, load: () => Promise.resolve(msal) },
    accountStore: sessionAccountStore("microsoft:max@contoso.com", storage),
  });
  return { msal, session, storage };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("MicrosoftAuthSession", () => {
  it("gets tokens silently for its MSAL account", async () => {
    const max = account("max@contoso.com");
    const { session, msal } = setup({
      getAllAccounts: () => [account("other@contoso.com"), max],
      acquireTokenSilent: vi.fn(() => Promise.resolve(result(max))),
    });
    expect(session.status).toBe("signed-in");
    expect(await session.getAccessToken()).toBe("token-1");
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ account: max }),
    );
    // MSAL renews by itself: nothing should refresh it on a click.
    expect(session.expiresAt).toBeUndefined();
  });

  it("tries single sign-on when this tab doesn't know the account yet", async () => {
    const max = account("max@contoso.com");
    const { session, msal, storage } = setup({
      ssoSilent: vi.fn(() => Promise.resolve(result(max))),
    });
    expect(await session.getAccessToken()).toBe("token-1");
    expect(msal.ssoSilent).toHaveBeenCalledWith(
      expect.objectContaining({ loginHint: "max@contoso.com" }),
    );
    expect(
      storage.getItem("a0.microsoft.account.microsoft:max@contoso.com"),
    ).toBe("home-max@contoso.com");
  });

  it("asks for a reconnect when MSAL needs the user, then stops trying", async () => {
    const max = account("max@contoso.com");
    const silent = vi.fn(() =>
      Promise.reject(
        msalError("interaction_required", "", "InteractionRequiredAuthError"),
      ),
    );
    const { session } = setup({
      getAllAccounts: () => [max],
      acquireTokenSilent: silent,
    });
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.status));
    const error = await failure(session.getAccessToken());
    expect(isMailError(error, "auth-required") && error.params.provider).toBe(
      "Microsoft",
    );
    expect(session.status).toBe("expired");
    expect(statuses).toEqual(["expired"]);
    await failure(session.getAccessToken());
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("reconnects with a popup for the same account", async () => {
    const max = account("max@contoso.com");
    const { session, msal } = setup({
      acquireTokenPopup: vi.fn(() => Promise.resolve(result(max))),
    });
    session.markExpired();
    await session.signIn();
    expect(session.status).toBe("signed-in");
    expect(msal.acquireTokenPopup).toHaveBeenCalledWith(
      expect.objectContaining({ loginHint: "max@contoso.com" }),
    );
  });

  it("refuses another account chosen in the popup", async () => {
    const other = account("eve@contoso.com");
    const { session, msal } = setup({
      acquireTokenPopup: vi.fn(() => Promise.resolve(result(other))),
    });
    session.markExpired();
    const error = await failure(session.signIn());
    expect(isMailError(error) && error.reason).toBe("wrongAccount");
    expect(msal.clearCache).toHaveBeenCalledWith({ account: other });
    expect(session.status).toBe("expired");
  });

  it.each([
    ["user_cancelled", "", "signInClosed"],
    ["popup_window_error", "", "signInBlocked"],
    [
      "invalid_grant",
      "AADSTS65001: The user or administrator has not consented",
      "adminApprovalNeeded",
    ],
    ["access_denied", "", "accessNotGranted"],
    [
      "server_error",
      "AADSTS50011: The redirect URI does not match",
      "signInFailed",
    ],
  ])("explains %s from the popup", async (code, message, reason) => {
    const { session } = setup({
      acquireTokenPopup: vi.fn(() => Promise.reject(msalError(code, message))),
    });
    const error = await failure(session.signIn());
    expect(isMailError(error) && error.reason).toBe(reason);
  });

  it("forgets the account in action0 only on sign-out", async () => {
    const max = account("max@contoso.com");
    const { session, msal } = setup({ getAllAccounts: () => [max] });
    await session.signOut();
    expect(session.status).toBe("signed-out");
    expect(msal.clearCache).toHaveBeenCalledWith({ account: max });
    await failure(session.getAccessToken());
  });
});

describe("MicrosoftAuthSession extra scopes", () => {
  const CALENDAR = ["Calendars.ReadWrite"];

  it("reports missing consent without touching mail, and asks for it in a popup", async () => {
    const max = account("max@contoso.com");
    let consented = false;
    const silent = vi.fn((request: { scopes: string[] }) =>
      request.scopes.includes("Calendars.ReadWrite") && !consented
        ? Promise.reject(
            msalError(
              "invalid_grant",
              "AADSTS65001",
              "InteractionRequiredAuthError",
            ),
          )
        : Promise.resolve(result(max, "token-x")),
    );
    const { session } = setup({
      getAllAccounts: () => [max],
      acquireTokenSilent: silent,
      acquireTokenPopup: vi.fn(() => {
        consented = true;
        return Promise.resolve(result(max));
      }),
    });
    expect(session.hasScopes(CALENDAR)).toBe(true);
    const error = await failure(session.tokenFor(CALENDAR));
    expect(isMailError(error, "unavailable") && error.reason).toBe(
      "calendarAccessNeeded",
    );
    expect(session.hasScopes(CALENDAR)).toBe(false);
    expect(session.status).toBe("signed-in");

    await session.requestScopes(CALENDAR);
    expect(session.hasScopes(CALENDAR)).toBe(true);
    expect(await session.tokenFor(CALENDAR)).toBe("token-x");
  });
});
