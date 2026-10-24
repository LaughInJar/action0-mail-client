import { useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId, MessageRef } from "../../core/ids";
import type { I18n } from "../../i18n/context";
import { useRouter } from "../../state/context";
import type { ToolbarItem } from "../actions/mailActionItems";

/** Showing a message's original (headers and source). */
export interface OriginalActions {
  /** The account's provider can deliver a message's source. */
  readonly canShow: (accountId: AccountId) => boolean;
  /** Opens the original over the current screen (Back closes it). */
  readonly show: (message: MessageRef) => void;
}

/** {@link OriginalActions} for the connected accounts. */
export function useOriginalActions(): OriginalActions {
  const accounts = useAccounts();
  const router = useRouter();
  return useMemo(
    () => ({
      canShow: (accountId) =>
        accounts.some(
          (handle) =>
            handle.account.id === accountId &&
            handle.provider.capabilities.rawSource,
        ),
      show: router.openOriginal,
    }),
    [accounts, router],
  );
}

/**
 * "Show original" for a message (or the one a function names when it's
 * chosen, like a conversation's cursor), as an item of the ⋯ menu; none
 * if its account can't.
 */
export function originalItems(
  actions: OriginalActions,
  message: MessageRef | (() => MessageRef),
  t: I18n,
): ToolbarItem[] {
  const target = () => (typeof message === "function" ? message() : message);
  if (!actions.canShow(target().accountId)) return [];
  return [
    {
      id: "original",
      label: t.original.showButton,
      icon: "code",
      menuOnly: true,
      group: "mail",
      run: () => {
        actions.show(target());
      },
    },
  ];
}
