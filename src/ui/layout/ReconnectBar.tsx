import { useEffect, useState } from "react";
import {
  useAccounts,
  useAuthExpiry,
  useAuthStatus,
} from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { REFRESH_WINDOW_MS } from "../../auth/refreshOnInteraction";
import { errorMessage } from "../common/errorMessage";
import { useCoarsePointer } from "./useBreakpoint";

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
          ? `Reconnect ${handle.account.email} to keep reading mail.`
          : `The session for ${handle.account.email} expires soon.`}
      </span>
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          handle.auth.signIn().catch((cause: unknown) => {
            setError(errorMessage(cause));
          });
        }}
        className="rounded-md bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700 pointer-coarse:min-h-11"
      >
        Reconnect
      </button>
      {error !== undefined && (
        <span className="w-full text-red-700 dark:text-red-300">{error}</span>
      )}
    </div>
  );
}
