import { useEffect } from "react";
import { useAccounts, useSignedIn } from "../../accounts/context";
import { focusViews, isFocusView, isSplit } from "../../core/focus";
import type { AccountId } from "../../core/ids";
import { useMailboxesOf } from "../../data/hooks";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";

/** The account's Focused Inbox switch (undefined: automatic). */
export function useFocusSetting(
  accountId: AccountId | undefined,
): boolean | undefined {
  return useUi((state) =>
    accountId === undefined
      ? undefined
      : state.settings.focusedInbox[accountId],
  );
}

/**
 * Keeps Outlook's Focused Inbox in step:
 * - an account found split (Outlook put mail into Other) is recorded as
 *   split, so the tabs stay when Other empties;
 * - the Inbox of a split account shows as Focused, and Focused or Other of
 *   an account that isn't split (anymore) as the Inbox (the URL is
 *   replaced; a search keeps its place).
 */
export function useFocusedInbox(): void {
  const accounts = useAccounts();
  const signedIn = useSignedIn(accounts);
  const all = useMailboxesOf(accounts, signedIn);
  const settings = useUi((state) => state.settings.focusedInbox);
  const store = useUiStore();
  const route = useRoute();
  const router = useRouter();

  useEffect(() => {
    const found = [...all].flatMap(([accountId, { data }]) =>
      data &&
      settings[accountId] === undefined &&
      focusViews(data) &&
      isSplit(data, undefined)
        ? [accountId]
        : [],
    );
    if (found.length > 0)
      store.getState().updateSettings({
        focusedInbox: {
          ...settings,
          ...Object.fromEntries(found.map((id) => [id, true])),
        },
      });
  }, [all, settings, store]);

  const mailboxes = route === null ? undefined : all.get(route.accountId)?.data;
  useEffect(() => {
    if (!route || route.unified || route.search || !mailboxes) return;
    const mailbox = mailboxes.find(
      (candidate) => candidate.id === route.mailboxId,
    );
    const views = focusViews(mailboxes);
    if (!mailbox || !views) return;
    const split = isSplit(mailboxes, settings[route.accountId]);
    const target =
      split && mailbox.role === "inbox"
        ? views.focused.id
        : !split && isFocusView(mailbox)
          ? mailbox.parentId
          : undefined;
    if (target !== undefined)
      router.navigate({ ...route, mailboxId: target }, { replace: true });
  }, [route, mailboxes, settings, router]);
}
