/**
 * Calendar servers (CalDAV) in the apps: the native side's servers, the
 * calendars of mail server accounts and of calendar-only servers, and what
 * their providers need from the rest of the app: which account sends a
 * calendar mail from an address, the user's addresses, and the mails'
 * texts. Those are bound late, since the account registry is made after
 * the provider modules.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { CalendarServerInfo } from "../accounts/calendarServer";
import type { CalendarProvider } from "../core/calendar";
import type { Account, Sender } from "../core/model";
import type { CalendarServerSources } from "../data/calendarServers";
import { queryKeys } from "../data/keys";
import { browserLanguages, localeFor, resolveLanguage } from "../i18n/locale";
import { messages } from "../i18n/messages";
import type { CaldavBridge } from "../providers/caldav/bridge";
import {
  CaldavCalendarProvider,
  type CaldavProviderOptions,
} from "../providers/caldav/CaldavCalendarProvider";
import type { CalendarMailer, ItipTexts } from "../providers/caldav/itip";
import {
  createCalendarServers,
  type CalendarServerList,
} from "../providers/caldav/servers";
import type { UiStore } from "../state/uiStore";

/** What the providers use of the app, once it exists. */
interface Bound {
  readonly registry: AccountRegistry;
  readonly queryClient: QueryClient;
  readonly uiStore: UiStore;
}

/** See the module docs. */
export interface CaldavServices {
  readonly servers: CalendarServerList;
  /** The calendars of a mail server account ("Set up calendar" until it has a server). */
  readonly accountCalendar: (account: Account) => CalendarProvider;
  /** The servers for the calendar column and its dialogs. */
  readonly sources: CalendarServerSources;
  /** Connects the providers to the app's accounts, cache and settings. */
  readonly bind: (app: Bound) => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createCaldavServices(bridge: CaldavBridge): CaldavServices {
  const servers = createCalendarServers(bridge);
  let app: Bound | undefined;

  /** An account's addresses as last loaded (the From list's). */
  const sendersOf = (accountId: string): readonly Sender[] =>
    app?.queryClient.getQueryData<readonly Sender[]>(
      queryKeys.senders(accountId as Account["id"]),
    ) ?? [];

  /** Sends from the account an address belongs to, if it can send calendar mail. */
  const mailerFor = (address: string): CalendarMailer | undefined => {
    const handle = app?.registry
      .list()
      .find(
        (candidate) =>
          candidate.provider.capabilities.calendarMail &&
          (same(candidate.account.email, address) ||
            sendersOf(candidate.account.id).some((sender) =>
              same(sender.address, address),
            )),
      );
    return handle
      ? (mail) => handle.provider.sendCalendarMail(mail)
      : undefined;
  };

  const texts = (): ItipTexts => {
    const language = app
      ? resolveLanguage(
          app.uiStore.getState().settings.language,
          browserLanguages(),
        )
      : "en";
    return {
      locale: localeFor(language, browserLanguages()),
      ...messages[language].calendar.itip,
    };
  };

  /** The name the user goes by at an address (its sender's, if known). */
  const nameAt = (address: string): string | undefined => {
    for (const handle of app?.registry.list() ?? []) {
      const sender = sendersOf(handle.account.id).find((candidate) =>
        same(candidate.address, address),
      );
      if (sender?.name) return sender.name;
    }
    return undefined;
  };

  const provider = (key: string, identity: CaldavProviderOptions["identity"]) =>
    new CaldavCalendarProvider({
      bridge,
      key,
      servers,
      identity,
      mailerFor,
      texts,
    });

  const calendarOnly = new Map<string, CalendarProvider>();
  const providerFor = (info: CalendarServerInfo): CalendarProvider => {
    let found = calendarOnly.get(info.key);
    if (!found) {
      found = provider(info.key, () => {
        const address = servers.info(info.key)?.address;
        const name = address ? nameAt(address) : undefined;
        return {
          me: address ? { address, ...(name ? { name } : {}) } : undefined,
          addresses: address ? [address] : [],
        };
      });
      calendarOnly.set(info.key, found);
    }
    return found;
  };

  return {
    servers,
    accountCalendar: (account) =>
      provider(account.id, () => {
        const senders = sendersOf(account.id);
        const name =
          senders.find((sender) => sender.isDefault)?.name ??
          nameAt(account.email);
        return {
          me: { address: account.email, ...(name ? { name } : {}) },
          addresses: [
            account.email,
            ...senders.map((sender) => sender.address),
          ],
        };
      }),
    sources: {
      servers,
      current: servers.current,
      subscribe: servers.subscribe,
      providerFor,
    },
    bind: (bound) => {
      app = bound;
    },
  };
}
