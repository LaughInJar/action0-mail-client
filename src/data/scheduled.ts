import { useAccounts, useSignedIn } from "../accounts/context";
import type { AccountId } from "../core/ids";
import type { ScheduledEntry } from "../core/schedule";
import { messageListOptions, useMailboxesOf } from "./hooks";
import { useInfiniteLists } from "./infiniteLists";

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
