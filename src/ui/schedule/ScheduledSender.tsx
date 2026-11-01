import { useEffect, useRef, useState } from "react";
import { isDue, isMissed } from "../../core/schedule";
import { useDraftSync } from "../../data/drafts";
import { useScheduledMail, type ScheduledEntry } from "../../data/scheduled";
import { useT } from "../../i18n/context";
import { deviceIdOf } from "../../state/device";
import { useRouter, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { formatSendAt } from "../common/format";
import { ALL_INBOXES_FROM } from "../mailboxes/allInboxes";
import { useAccounts } from "../../accounts/context";

/** How often due mail is looked for. */
export const SEND_CHECK_MS = 15_000;

const keyOf = (entry: ScheduledEntry) =>
  `${entry.accountId}|${entry.message.id}`;

/**
 * Sends scheduled mail that waits in Drafts once it's due, while the app
 * runs (also in the background and, in the desktop app, from the tray).
 * Mail more than 30 minutes late isn't sent unasked: a bar says so, with
 * Send now and Open.
 */
export function ScheduledSender() {
  const { entries } = useScheduledMail(true);
  const sync = useDraftSync();
  const store = useUiStore();
  const router = useRouter();
  const accounts = useAccounts();
  const t = useT();
  const s = t.schedule;
  const [now, setNow] = useState(() => Date.now());
  /** Mail tried already in this run (a failure isn't retried every tick). */
  const tried = useRef(new Set<string>());
  /** Missed mail the bar sent, or that the user said "Not now" to, in this run. */
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
    };
    const timer = setInterval(tick, SEND_CHECK_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, []);

  /** Not while it's open in the composer, or waiting to go out already. */
  const busy = (draftId: string) => {
    const { composer, pendingSends } = store.getState();
    return (
      composer?.draftId === draftId ||
      pendingSends.some((pending) => pending.session.draftId === draftId)
    );
  };

  const send = (entry: ScheduledEntry) => {
    tried.current.add(keyOf(entry));
    const subject = entry.message.subject.trim() || t.common.noSubject;
    sync.sendScheduled(entry.accountId, entry.message.id, busy).then(
      (sent) => {
        if (sent)
          store
            .getState()
            .showToast({ message: s.sent(subject), tone: "info" });
      },
      (error: unknown) => {
        store.getState().showToast({
          message: `${s.couldntSend}: ${errorMessage(error, t)}`,
          tone: "error",
        });
      },
    );
  };

  // What's due goes out.
  useEffect(() => {
    const device = deviceIdOf(store);
    for (const entry of entries) {
      if (entry.scheduling !== "drafts" || tried.current.has(keyOf(entry)))
        continue;
      if (isDue(entry.message, now, device)) send(entry);
    }
    // `send` only reads the store and stable services.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, now]);

  const missed = entries.filter(
    (entry) =>
      entry.scheduling === "drafts" &&
      isMissed(entry.message.sendAt, now) &&
      !handled.has(keyOf(entry)),
  );
  const [first] = missed;
  if (!first) return null;

  const open = () => {
    const combined =
      accounts.length >= ALL_INBOXES_FROM &&
      missed.some((entry) => entry.accountId !== first.accountId);
    router.navigate(
      combined
        ? {
            accountId: first.accountId,
            mailboxId: first.mailboxId,
            unified: true,
            combined: "scheduled",
          }
        : {
            accountId: first.accountId,
            mailboxId: first.mailboxId,
            messageId: first.message.id,
          },
    );
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="min-w-0 flex-1">
        {s.missed(
          missed.length,
          formatSendAt(first.message.sendAt, { locale: t.locale }),
        )}
      </span>
      <button
        type="button"
        onClick={() => {
          for (const entry of missed) send(entry);
          setHandled((before) => new Set([...before, ...missed.map(keyOf)]));
        }}
        className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
      >
        {s.sendNow}
      </button>
      <button
        type="button"
        onClick={open}
        className="rounded-md px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900 pointer-coarse:min-h-11"
      >
        {s.open}
      </button>
      <button
        type="button"
        onClick={() => {
          setHandled((before) => new Set([...before, ...missed.map(keyOf)]));
        }}
        className="rounded-md px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900 pointer-coarse:min-h-11"
      >
        {s.dismiss}
      </button>
    </div>
  );
}
