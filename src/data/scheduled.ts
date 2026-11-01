import { useMemo } from "react";
import { useAccounts, useSignedIn } from "../accounts/context";
import { messageKey, type AccountId, type MailboxId } from "../core/ids";
import type { MessageSummary } from "../core/model";
import type { ScheduledEntry } from "../core/schedule";
import { messageListOptions, useMailboxesOf } from "./hooks";
import { useInfiniteLists } from "./infiniteLists";
import { messageRows, type ListRow } from "./listRows";

export type { ScheduledEntry };

/** How often each account's Scheduled list is checked while the app runs. */
export const SCHEDULED_REFRESH_MS = 60_000;

/** Every account's scheduled mail (as far as it's loaded). */
export interface ScheduledMail {
  /** Soonest first. */
  readonly entries: readonly ScheduledEntry[];
  /** How many each account has (the folder tree shows Scheduled while there are any). */
  readonly counts: ReadonlyMap<AccountId, number>;
}

/** The scheduled mail a message is, if it is (and its list is loaded). */
export function useScheduledEntry(
  accountId: AccountId | undefined,
  messageId: string | undefined,
): ScheduledEntry | undefined {
  return useScheduledMail().entries.find(
    (entry) => entry.accountId === accountId && entry.message.id === messageId,
  );
}

/**
 * The first page of each account's Scheduled view. It's the view's own
 * cached list, so the list pane and this agree; `refresh` keeps it current
 * (every minute, also in the background: the one that sends asks for that).
 */
export function useScheduledMail(refresh = false): ScheduledMail {
  const accounts = useAccounts();
  const signedIn = useSignedIn(accounts);
  const mailboxes = useMailboxesOf(accounts, signedIn);
  const plans = accounts.flatMap((handle) => {
    const scheduling = handle.provider.capabilities.scheduling;
    const view = mailboxes
      .get(handle.account.id)
      ?.data?.find((mailbox) => mailbox.role === "scheduled");
    return scheduling && view
      ? [
          {
            handle,
            scheduling,
            mailboxId: view.id,
            ready: signedIn.has(handle.account.id),
          },
        ]
      : [];
  });
  const results = useInfiniteLists(
    plans.map((plan) => ({
      ...messageListOptions(
        plan.handle.account.id,
        plan.ready ? plan.handle : undefined,
        { mailboxId: plan.mailboxId, order: "newest" },
      ),
      ...(refresh
        ? {
            refetchInterval: SCHEDULED_REFRESH_MS,
            refetchIntervalInBackground: true,
          }
        : {}),
    })),
  );
  const entries: ScheduledEntry[] = [];
  const counts = new Map<AccountId, number>();
  plans.forEach((plan, index) => {
    const rows =
      results[index]?.data?.pages.flatMap((page) => page.items) ?? [];
    const scheduled = rows.flatMap((message) =>
      message.sendAt === undefined
        ? []
        : [{ ...message, sendAt: message.sendAt }],
    );
    counts.set(plan.handle.account.id, scheduled.length);
    entries.push(
      ...scheduled.map((message) => ({
        accountId: plan.handle.account.id,
        mailboxId: plan.mailboxId,
        scheduling: plan.scheduling,
        message,
      })),
    );
  });
  entries.sort((a, b) => a.message.sendAt.localeCompare(b.message.sendAt));
  return { entries, counts };
}

/** A snoozed message of an account. */
export interface SnoozedEntry {
  readonly accountId: AccountId;
  /** The account's Snoozed mailbox. */
  readonly mailboxId: MailboxId;
  /** Its row, with `snoozedUntil`. */
  readonly message: MessageSummary & { readonly snoozedUntil: string };
}

/** Every account's snoozed mail (as far as it's loaded). */
export interface SnoozedMail {
  /** Back soonest first. */
  readonly entries: readonly SnoozedEntry[];
  /** How many each account has (the folder tree shows Snoozed while there are any). */
  readonly counts: ReadonlyMap<AccountId, number>;
}

/** The snoozed message a message is, if it is (and its list is loaded). */
export function useSnoozedEntry(
  accountId: AccountId | undefined,
  messageId: string | undefined,
): SnoozedEntry | undefined {
  return useSnoozedMail().entries.find(
    (entry) => entry.accountId === accountId && entry.message.id === messageId,
  );
}

/**
 * The first page of each account's Snoozed mailbox, like
 * {@link useScheduledMail} (`refresh`: the one that brings mail back asks
 * for it to be kept current).
 */
export function useSnoozedMail(refresh = false): SnoozedMail {
  const accounts = useAccounts();
  const signedIn = useSignedIn(accounts);
  const mailboxes = useMailboxesOf(accounts, signedIn);
  const plans = accounts.flatMap((handle) => {
    const mailbox = mailboxes
      .get(handle.account.id)
      ?.data?.find((candidate) => candidate.role === "snoozed");
    return handle.provider.capabilities.snooze && mailbox
      ? [
          {
            handle,
            mailboxId: mailbox.id,
            ready: signedIn.has(handle.account.id),
          },
        ]
      : [];
  });
  const results = useInfiniteLists(
    plans.map((plan) => ({
      ...messageListOptions(
        plan.handle.account.id,
        plan.ready ? plan.handle : undefined,
        { mailboxId: plan.mailboxId, order: "newest" },
      ),
      ...(refresh
        ? {
            refetchInterval: SCHEDULED_REFRESH_MS,
            refetchIntervalInBackground: true,
          }
        : {}),
    })),
  );
  const entries: SnoozedEntry[] = [];
  const counts = new Map<AccountId, number>();
  plans.forEach((plan, index) => {
    const rows =
      results[index]?.data?.pages.flatMap((page) => page.items) ?? [];
    const snoozed = rows.flatMap((message) =>
      message.snoozedUntil === undefined
        ? []
        : [{ ...message, snoozedUntil: message.snoozedUntil }],
    );
    counts.set(plan.handle.account.id, snoozed.length);
    entries.push(
      ...snoozed.map((message) => ({
        accountId: plan.handle.account.id,
        mailboxId: plan.mailboxId,
        message,
      })),
    );
  });
  entries.sort((a, b) =>
    a.message.snoozedUntil.localeCompare(b.message.snoozedUntil),
  );
  return { entries, counts };
}

/**
 * Inbox mail of these accounts that came back from snooze and hasn't been
 * opened (each account's hidden "back from snooze" view), as rows pinned
 * atop the Inbox; none unless `enabled`.
 */
export function useBackFromSnooze(
  accountIds: readonly AccountId[],
  enabled: boolean,
): readonly ListRow[] {
  const accounts = useAccounts();
  const signedIn = useSignedIn(accounts);
  const mailboxes = useMailboxesOf(accounts, signedIn);
  const plans = enabled
    ? accounts.flatMap((handle) => {
        const accountId = handle.account.id;
        if (!accountIds.includes(accountId)) return [];
        const boxes = mailboxes.get(accountId)?.data;
        const view = boxes?.find(
          (mailbox) => mailbox.standard === "backFromSnooze",
        );
        const inbox = boxes?.find((mailbox) => mailbox.role === "inbox");
        return view && inbox
          ? [
              {
                handle,
                view: view.id,
                inbox: inbox.id,
                ready: signedIn.has(accountId),
              },
            ]
          : [];
      })
    : [];
  const results = useInfiniteLists(
    plans.map((plan) =>
      messageListOptions(
        plan.handle.account.id,
        plan.ready ? plan.handle : undefined,
        { mailboxId: plan.view, order: "newest" },
      ),
    ),
  );
  // Stable while nothing changes, so the list's rows are too.
  const signature = JSON.stringify([
    plans.map((plan) => [plan.handle.account.id, plan.inbox]),
    results.map((result) => result.dataUpdatedAt),
  ]);
  return useMemo(
    () =>
      plans.flatMap((plan, index) =>
        messageRows(
          plan.handle.account.id,
          (
            results[index]?.data?.pages.flatMap((page) => page.items) ?? []
          ).filter(
            // Archived or moved meanwhile: no longer pinned.
            (message) =>
              message.backFromSnooze === true &&
              message.mailboxIds.includes(plan.inbox),
          ),
        ),
      ),
    // The signature stands for the plans and their data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
}

/** `rows` with `pinned` first (and not again further down). */
export function pinRows(
  rows: readonly ListRow[],
  pinned: readonly ListRow[],
): ListRow[] {
  if (pinned.length === 0) return [...rows];
  const keys = new Set(pinned.map((row) => row.key));
  return [
    ...pinned,
    ...rows.filter(
      (row) =>
        !keys.has(row.key) &&
        !(
          row.thread?.messages.some((message) =>
            keys.has(messageKey(row.accountId, message.id)),
          ) ?? false
        ),
    ),
  ];
}
