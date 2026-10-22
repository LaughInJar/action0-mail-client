import { useQueryClient } from "@tanstack/react-query";
import { useContext, useMemo } from "react";
import type { IcsSubscription } from "../../core/calendar";
import { MailError } from "../../core/errors";
import { IcsFactoryContext } from "../../data/calendar";
import { queryKeys } from "../../data/keys";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";

/** Colours offered for iCal calendars. */
export const SUBSCRIPTION_COLORS: readonly string[] = [
  "#8e24aa",
  "#039be5",
  "#33b679",
  "#f6bf26",
  "#f4511e",
  "#d50000",
  "#616161",
  "#3f51b5",
];

/** The https address of what the user typed (`webcal:` → `https:`), if it's one. */
export function subscriptionUrl(raw: string): string | undefined {
  const text = raw.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Adding, changing and removing iCal subscriptions (kept in the settings). */
export function useSubscriptions() {
  const store = useUiStore();
  const queryClient = useQueryClient();
  const factory = useContext(IcsFactoryContext);
  const t = useT();
  return useMemo(() => {
    const list = () => store.getState().settings.icsCalendars;
    const save = (icsCalendars: readonly IcsSubscription[]) => {
      store.getState().updateSettings({ icsCalendars });
    };
    return {
      /**
       * Checks that the address can be read from here (loading a day of
       * it), then saves it. Rejects with the reason it can't.
       */
      save: async (
        subscription: Omit<IcsSubscription, "url"> & { readonly url: string },
        signal?: AbortSignal,
      ): Promise<IcsSubscription> => {
        const url = subscriptionUrl(subscription.url);
        if (url === undefined)
          throw new MailError("provider", "Not a web address.", {
            reason: "icsBadUrl",
          });
        const next: IcsSubscription = {
          ...subscription,
          url,
          name: subscription.name.trim() || t.calendar.defaultName,
        };
        const known = list().find((entry) => entry.id === next.id);
        if (factory && known?.url !== url) {
          const probe = factory(next);
          const now = new Date();
          const [calendar] = await probe.listCalendars(signal);
          if (calendar)
            await probe.listEvents(
              [calendar.id],
              {
                from: now.toISOString(),
                to: new Date(now.getTime() + 86_400_000).toISOString(),
              },
              signal,
            );
        }
        save(
          known
            ? list().map((entry) => (entry.id === next.id ? next : entry))
            : [...list(), next],
        );
        if (known)
          queryClient.removeQueries({
            queryKey: queryKeys.calendarSource(`ics:${next.id}`),
          });
        return next;
      },
      remove: (id: string) => {
        save(list().filter((entry) => entry.id !== id));
        queryClient.removeQueries({
          queryKey: queryKeys.calendarSource(`ics:${id}`),
        });
      },
    };
  }, [store, queryClient, factory, t]);
}
