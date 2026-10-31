import { useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import type { EmailAddress } from "../../core/model";
import type { I18n } from "../../i18n/context";
import { useRouter } from "../../state/context";
import type { HashRouter } from "../../state/router";
import type { ToolbarItem } from "../actions/mailActionItems";

/** DOM id of Settings → Filters. */
export const FILTER_SETTINGS_ID = "settings-filters";

/** What Settings → Filters was asked to open. */
export type FilterRequest =
  | {
      readonly kind: "filter";
      readonly accountId: AccountId;
      /** The sender whose mail the new filter is for. */
      readonly from?: string;
    }
  | { readonly kind: "auto-reply"; readonly accountId: AccountId };

let requested: FilterRequest | undefined;

/** Opens Settings → Filters with a new filter (or the automatic reply) of an account. */
export function openFilterSettings(
  router: HashRouter,
  request: FilterRequest,
): void {
  requested = request;
  router.openSettings();
}

/** What {@link openFilterSettings} asked for, once. */
export function takeFilterRequest(): FilterRequest | undefined {
  const request = requested;
  requested = undefined;
  return request;
}

/** The account Settings → Filters was asked to show, without taking the request. */
export function requestedFilterAccount(): AccountId | undefined {
  return requested?.accountId;
}

/** What was asked for an account, without taking it. */
export function filterRequestFor(
  accountId: AccountId,
): FilterRequest | undefined {
  return requested?.accountId === accountId ? requested : undefined;
}

/** "Filter mail like this" from a message. */
export interface FilterLinkActions {
  /** The account has filters. */
  readonly canFilter: (accountId: AccountId) => boolean;
  /** Opens a new filter for mail from `from`. */
  readonly filterLike: (
    accountId: AccountId,
    from: EmailAddress | undefined,
  ) => void;
}

/** {@link FilterLinkActions} for the connected accounts. */
export function useFilterLinkActions(): FilterLinkActions {
  const accounts = useAccounts();
  const router = useRouter();
  return useMemo(
    () => ({
      canFilter: (accountId) =>
        accounts.some(
          (handle) =>
            handle.account.id === accountId && handle.filters !== undefined,
        ),
      filterLike: (accountId, from) => {
        openFilterSettings(router, {
          kind: "filter",
          accountId,
          ...(from ? { from: from.address } : {}),
        });
      },
    }),
    [accounts, router],
  );
}

/**
 * "Filter mail like this" for a message (or the one a function names when
 * it's chosen), as an item of the ⋯ menu; none if its account has no filters.
 */
export function filterItems(
  actions: FilterLinkActions,
  message:
    | { readonly accountId: AccountId; readonly from?: EmailAddress }
    | (() => { readonly accountId: AccountId; readonly from?: EmailAddress }),
  t: I18n,
): ToolbarItem[] {
  const target = () => (typeof message === "function" ? message() : message);
  if (!actions.canFilter(target().accountId)) return [];
  return [
    {
      id: "filter",
      label: t.filters.filterLikeThis,
      icon: "filter",
      menuOnly: true,
      group: "mail",
      run: () => {
        const { accountId, from } = target();
        actions.filterLike(accountId, from);
      },
    },
  ];
}
