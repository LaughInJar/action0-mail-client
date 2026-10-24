import { useEffect, useState } from "react";
import { useUi } from "../../state/context";
import type { ComposeActions } from "./useComposeActions";
import { useT } from "../../i18n/context";

/**
 * Mail waiting out its undo period: "Sending in 23 s" with Undo and Send
 * now (just "Sending…" when undo send is off). Stays until the mail is
 * sent, independent of other toasts.
 */
export function SendQueueBar({ actions }: { actions: ComposeActions }) {
  const pending = useUi((state) => state.pendingSends);
  const t = useT();
  const c = t.composer;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const tick = () => {
      setNow(Date.now());
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pending.length]);
  if (pending.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex flex-col items-center gap-2 px-4 pb-[var(--safe-bottom)]">
      {pending.map((item) => {
        // `now` may predate the item until the next tick.
        const left = item.sendAt - Math.max(now, item.queuedAt);
        const seconds = Math.max(1, Math.ceil(left / 1000));
        const subject = item.session.subject.trim() || t.common.noSubject;
        // Undo send is off: it's on its way already.
        if (item.sendAt <= item.queuedAt)
          return (
            <div
              key={item.id}
              role="status"
              className="pointer-events-auto max-w-full truncate rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
            >
              {c.sending(subject)}
            </div>
          );
        return (
          <div
            key={item.id}
            role="status"
            className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg bg-zinc-900 py-2 pr-2 pl-4 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
          >
            <span className="min-w-0 truncate">
              {c.sendingIn(subject, seconds)}
            </span>
            <button
              type="button"
              onClick={() => {
                actions.undoSend(item.id);
              }}
              className="rounded px-2 py-1 font-semibold hover:bg-white/15 dark:hover:bg-black/10 pointer-coarse:min-h-11"
            >
              {t.common.undo}{" "}
              <kbd className="ml-0.5 font-sans text-xs opacity-70 pointer-coarse:hidden">
                z
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => {
                actions.sendNow(item.id);
              }}
              className="rounded px-2 py-1 font-semibold hover:bg-white/15 dark:hover:bg-black/10 pointer-coarse:min-h-11"
            >
              {c.sendNow}
            </button>
          </div>
        );
      })}
    </div>
  );
}
