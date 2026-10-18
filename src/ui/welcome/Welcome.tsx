import { useId } from "react";
import { AddAccountFlow } from "../accounts/AddAccountFlow";
import { Icon } from "../common/Icon";

/** Shown while no account is connected: the Add account wizard, inline. */
export function Welcome() {
  const titleId = useId();
  return (
    <main className="grid min-h-dvh place-items-center bg-zinc-50 px-4 py-[max(1rem,env(safe-area-inset-top))] dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <Icon
            name="mail"
            className="mx-auto size-12 text-blue-600 dark:text-blue-400"
          />
          <h1 className="text-2xl font-semibold">action0 mail</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            A fast, keyboard-first mail client that runs entirely in your
            browser.
          </p>
        </div>
        <section
          aria-labelledby={titleId}
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <AddAccountFlow titleId={titleId} />
        </section>
        <p className="text-center text-xs text-zinc-500">
          No server: mail is loaded directly from your provider into this
          browser, and this app doesn't store it.
        </p>
      </div>
    </main>
  );
}
