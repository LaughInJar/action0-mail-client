import { useEffect, useId, useState } from "react";
import {
  useAccounts,
  useAuthExpiry,
  useAuthStatus,
} from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { REFRESH_WINDOW_MS } from "../../auth/refreshOnInteraction";
import { errorMessage } from "../common/errorMessage";
import { useCoarsePointer } from "./useBreakpoint";
import { useT } from "../../i18n/context";

/** Current time, updated every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Offers a one-click reconnect for accounts whose session expired. On touch
 * devices it also appears shortly before expiry, because there the token is
 * not refreshed on interaction (the popup would open as a new tab mid-scroll).
 */
export function ReconnectBar() {
  const accounts = useAccounts();
  const coarse = useCoarsePointer();
  const now = useNow(30_000);
  return (
    <>
      {accounts.map((handle) => (
        <AccountReconnect
          key={handle.account.id}
          handle={handle}
          warnEarly={coarse}
          now={now}
        />
      ))}
    </>
  );
}

interface AccountReconnectProps {
  readonly handle: AccountHandle;
  readonly warnEarly: boolean;
  readonly now: number;
}

function AccountReconnect({ handle, warnEarly, now }: AccountReconnectProps) {
  const status = useAuthStatus(handle.auth);
  const expiresAt = useAuthExpiry(handle.auth);
  const [error, setError] = useState<string>();
  const [password, setPassword] = useState("");
  const passwordId = useId();
  const t = useT();
  // Mail server accounts sign in again with a password typed right here.
  const askPassword = handle.auth.reauth === "password";
  const expiringSoon =
    warnEarly &&
    status === "signed-in" &&
    expiresAt !== undefined &&
    expiresAt - now < REFRESH_WINDOW_MS;

  if (status !== "expired" && !expiringSoon) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="min-w-0 flex-1">
        {status === "expired"
          ? t.layout.reconnectExpired(handle.account.email)
          : t.layout.reconnectSoon(handle.account.email)}
      </span>
      {askPassword ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            handle.auth.signIn({ password }).then(
              () => {
                setPassword("");
              },
              (cause: unknown) => {
                setError(errorMessage(cause, t));
              },
            );
          }}
        >
          <label htmlFor={passwordId} className="sr-only">
            {t.imap.reconnectPassword(handle.account.email)}
          </label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            placeholder={t.imap.password}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className="w-40 rounded-md border border-amber-300 bg-white px-2 py-1 text-zinc-900 dark:border-amber-800 dark:bg-zinc-900 dark:text-zinc-100 pointer-coarse:min-h-11"
          />
          <button
            type="submit"
            disabled={password === ""}
            className="rounded-md bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700 disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {t.layout.reconnect}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(undefined);
            handle.auth.signIn().catch((cause: unknown) => {
              setError(errorMessage(cause, t));
            });
          }}
          className="rounded-md bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700 pointer-coarse:min-h-11"
        >
          {t.layout.reconnect}
        </button>
      )}
      {error !== undefined && (
        <span className="w-full text-red-700 dark:text-red-300">{error}</span>
      )}
    </div>
  );
}
