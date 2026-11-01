import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AccountId, MessageId } from "../../core/ids";
import { isDueBack } from "../../core/snooze";
import { cachedMailboxes, useApplyIntent } from "../../data/mutations";
import { useSnoozedMail, type SnoozedEntry } from "../../data/scheduled";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useRouter, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { SEND_CHECK_MS } from "./ScheduledSender";

/** The app is visible and focused: the Inbox shows it anyway. */
const appInFront = () => !document.hidden && document.hasFocus();

/**
 * Brings snoozed mail back into the Inbox when it's due, unread and
 * marked "back from snooze", while the app runs (also in the background
 * and from the desktop app's tray); mail that was due while nothing ran
 * comes back at the start. Says so with a notification (the notifications
 * setting) or, in front, a toast.
 */
export function SnoozeWaker() {
  const { entries } = useSnoozedMail(true);
  const { mutateAsync: apply } = useApplyIntent();
  const queryClient = useQueryClient();
  const store = useUiStore();
  const router = useRouter();
  const { notifications } = usePlatform();
  const t = useT();
  const z = t.snooze;
  const [now, setNow] = useState(() => Date.now());
  /** Messages brought back in this run (each once, even if that failed). */
  const tried = useRef(new Set<string>());

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

  useEffect(() => {
    const due = new Map<AccountId, SnoozedEntry[]>();
    for (const entry of entries) {
      const key = `${entry.accountId}|${entry.message.id}`;
      if (tried.current.has(key) || !isDueBack(entry.message.snoozedUntil, now))
        continue;
      tried.current.add(key);
      due.set(entry.accountId, [...(due.get(entry.accountId) ?? []), entry]);
    }
    for (const [accountId, back] of due) {
      const inbox = cachedMailboxes(queryClient, accountId).find(
        (mailbox) => mailbox.role === "inbox",
      );
      const ids: MessageId[] = back.map((entry) => entry.message.id);
      apply({
        accountId,
        intent: { kind: "unsnooze", ids, to: inbox?.id ?? null, back: true },
      }).then(
        () => {
          const [first] = back;
          if (!first) return;
          const text =
            back.length === 1
              ? z.backNotice(first.message.subject.trim() || t.common.noSubject)
              : z.backMany(back.length);
          if (
            store.getState().settings.notifications &&
            notifications.allowed() &&
            !appInFront()
          ) {
            notifications.show({
              title: text,
              body:
                first.message.from?.name ?? first.message.from?.address ?? "",
              tag: `a0-back-${first.message.id}`,
              onClick: () => {
                if (inbox)
                  router.navigate({
                    accountId,
                    mailboxId: inbox.id,
                    ...(back.length === 1
                      ? { messageId: first.message.id }
                      : {}),
                  });
              },
            });
          } else store.getState().showToast({ message: text, tone: "info" });
        },
        (error: unknown) => {
          store.getState().showToast({
            message: `${z.couldntWake}: ${errorMessage(error, t)}`,
            tone: "error",
          });
        },
      );
    }
    // Runs when the lists or the time change; the rest is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, now]);

  return null;
}
