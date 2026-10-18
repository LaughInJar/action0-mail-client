import { useState } from "react";
import { useAccountRegistry } from "../../accounts/context";
import type { ProviderType } from "../../core/model";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";

/** Shown while no account is connected. */
export function Welcome() {
  const registry = useAccountRegistry();
  const modules = registry.availableModules();
  const hasGmail = modules.some((module) => module.type === "gmail");
  const hasDemo = modules.some((module) => module.type === "demo");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const connect = (type: ProviderType) => {
    setError(undefined);
    setBusy(true);
    // No await before add(): the sign-in popup must open inside this click.
    registry
      .add(type)
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-zinc-50 px-4 py-[max(1rem,env(safe-area-inset-top))] dark:bg-zinc-950">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Icon
          name="mail"
          className="mx-auto size-12 text-blue-600 dark:text-blue-400"
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">action0 mail</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            A fast, keyboard-first mail client that runs entirely in your
            browser.
          </p>
        </div>

        <div className="space-y-3">
          {hasGmail ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                connect("gmail");
              }}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white shadow-sm hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
            >
              Sign in with Google
            </button>
          ) : (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Google sign-in isn’t configured yet. Put your OAuth client ID into{" "}
              <code>VITE_GOOGLE_CLIENT_ID</code> in <code>.env.local</code> (see
              the README).
            </p>
          )}
          {hasDemo && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                connect("demo");
              }}
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 font-medium text-zinc-800 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Try the demo
            </button>
          )}
          {error !== undefined && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <p className="text-xs text-zinc-500">
          Read-only access. Mail is loaded directly from your provider; this app
          has no server and doesn’t store your mail.
        </p>
      </div>
    </main>
  );
}
