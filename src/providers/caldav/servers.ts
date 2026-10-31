import type {
  CalendarServerInfo,
  CalendarServers,
} from "../../accounts/calendarServer";
import { Emitter } from "../../lib/emitter";
import type { CaldavBridge } from "./bridge";

/** What a calendar provider needs to know about its server. */
export interface CalendarServerDirectory {
  /** The connected server of a source, if any (known once {@link CalendarServerList.ready}). */
  readonly info: (key: string) => CalendarServerInfo | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

/** {@link CalendarServers}, with the list kept for providers. */
export type CalendarServerList = CalendarServers &
  CalendarServerDirectory & {
    /** Resolves once the kept servers are known. */
    readonly ready: Promise<void>;
    /** The connected servers right now (empty until {@link ready}). */
    readonly current: () => readonly CalendarServerInfo[];
    /** Looks for a server's address books (once), keeps and returns its info. */
    readonly findContacts: (key: string) => Promise<CalendarServerInfo>;
  };

/**
 * The calendar servers of the native side, listed once at start and kept
 * up to date as servers are connected and removed.
 */
export function createCalendarServers(
  bridge: CaldavBridge,
): CalendarServerList {
  const emitter = new Emitter();
  let servers = new Map<string, CalendarServerInfo>();
  let current: readonly CalendarServerInfo[] = [];
  const keep = (list: readonly CalendarServerInfo[]) => {
    servers = new Map(list.map((info) => [info.key, info]));
    current = [...servers.values()];
    emitter.emit();
  };
  const ready = bridge.servers().then(keep, () => {
    // No vault (no keychain): nothing was kept.
  });
  return {
    ready,
    current: () => current,
    info: (key) => servers.get(key),
    subscribe: (listener) => emitter.subscribe(listener),
    discover: (address, mailHost) => bridge.discover(address, mailHost),
    connect: async (setup) => {
      const info = await bridge.connect(setup);
      keep([...[...servers.values()].filter((s) => s.key !== info.key), info]);
      return info;
    },
    list: async () => {
      await ready;
      return [...servers.values()];
    },
    remove: async (key) => {
      await bridge.remove(key);
      keep([...servers.values()].filter((s) => s.key !== key));
    },
    findContacts: async (key) => {
      const info = await bridge.findContacts(key);
      keep([...[...servers.values()].filter((s) => s.key !== key), info]);
      return info;
    },
    forgetCertificate: async (key) => {
      await bridge.forgetCertificate(key);
      const info = servers.get(key);
      if (info)
        keep(
          [...servers.values()].map((s) =>
            s.key === key ? { ...s, pinned: false } : s,
          ),
        );
    },
  };
}
