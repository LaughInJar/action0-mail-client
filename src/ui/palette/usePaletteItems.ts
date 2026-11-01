import { useQueryClient } from "@tanstack/react-query";
import { useAccounts, useSignedIn } from "../../accounts/context";
import type { ContactSnapshot } from "../../core/contacts";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { listToken, useContactSources } from "../../data/contacts";
import { useMailboxesOf } from "../../data/hooks";
import { queryKeys } from "../../data/keys";
import { useT } from "../../i18n/context";
import { useRegisteredCommands } from "../../keyboard/context";
import { formatBinding } from "../../keyboard/keys";
import {
  useAppPart,
  useRoute,
  useRouter,
  useUiStore,
} from "../../state/context";
import {
  ALL_CONTACTS,
  COMBINED_VIEWS,
  type CalendarView,
  type Route,
} from "../../state/router";
import type { ThemeMode } from "../../state/theme";
import { useMarkAllRead } from "../actions/useMarkAllRead";
import { dayKey } from "../calendar/dates";
import type { IconName } from "../common/Icon";
import { isFocusView, isSplit } from "../../core/focus";
import { mailboxName, roleNamesOf } from "../common/mailboxNames";
import { focusWhenReady } from "../common/focusWhenReady";
import { mailboxTexts } from "../labels/mailboxTexts";
import { useBreakpoint } from "../layout/useBreakpoint";
import {
  ALL_INBOXES_FROM,
  combinedRoute,
  useOpenCombined,
} from "../mailboxes/allInboxes";
import { mailboxIcon, ROLE_ICONS } from "../mailboxes/mailboxIcon";
import { MESSAGE_LIST_ID } from "../messages/MessageList";
import { listKeyOf } from "../messages/useCurrentList";
import { openSettingsAt, useSettingsSections } from "../settings/sections";
import type { PaletteItem } from "./paletteItems";

/**
 * Commands the palette leaves out: moving the cursor (lists, the calendar's
 * days, the contacts), going to places (the palette lists the places
 * themselves) and the palette's own shortcut.
 */
const LEFT_OUT =
  /^(list\.|conversation\.|go\.|reader\.page-|palette\.)|^calendar\.(today|previous|next|day|week|month|agenda)$|^contacts\.(next|previous|extend-up|extend-down|toggle|open)$/;

const COMMAND_ICONS: Readonly<Record<string, IconName>> = {
  "mail.archive": "archive",
  "mail.mark-read": "mail-open",
  "mail.mark-unread": "mail",
  "mail.move": "folder",
  "mail.labels": "tag",
  "mail.star": "star",
  "mail.trash": "trash",
  "mail.spam": "alert",
  "mail.delete-forever": "trash",
  "mail.filter-like": "filter",
  "compose.new": "pencil",
  "compose.reply": "reply",
  "compose.reply-all": "reply-all",
  "compose.forward": "forward",
  "reader.print": "printer",
  "reader.original": "code",
  "ai.summarize": "sparkles",
  "ai.ask": "sparkles",
  "search.mail": "search",
  "search.folders": "filter",
  "calendar.new": "plus",
  "calendar.edit": "pencil",
  "calendar.delete": "trash",
  "contacts.new": "user-plus",
  "contacts.edit": "pencil",
  "contacts.delete": "trash",
  "contacts.search": "search",
  "app.quit": "log-out",
};

const THEMES: readonly (readonly [ThemeMode, IconName])[] = [
  ["system", "monitor"],
  ["light", "sun"],
  ["dark", "moon"],
];

/** A mailbox's name with its parents' ("Work / Clients"). */
function pathOf(
  mailbox: Mailbox,
  byId: ReadonlyMap<string, Mailbox>,
  name: (mailbox: Mailbox) => string,
): string {
  const names = [name(mailbox)];
  let parent = mailbox.parentId ? byId.get(mailbox.parentId) : undefined;
  // Bounded, in case a provider ever reports a cycle.
  while (parent && names.length < 20) {
    names.unshift(name(parent));
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return names.join(" / ");
}

/**
 * Everything the command palette offers right now: places (every
 * account's mailboxes, the combined views, the calendar's views, the
 * contacts' lists, Settings' sections), the keyboard commands that apply
 * (with their shortcuts), actions only the palette has, and — while
 * something is typed — "Search mail for …".
 */
export function usePaletteItems(query: string): PaletteItem[] {
  const t = useT();
  const p = t.palette;
  const router = useRouter();
  const store = useUiStore();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const signedIn = useSignedIn(accounts);
  const mailboxes = useMailboxesOf(accounts, signedIn);
  const registry = useRegisteredCommands();
  const route = useRoute();
  const part = useAppPart();
  const breakpoint = useBreakpoint();
  const sections = useSettingsSections();
  const contactSources = useContactSources();
  const openCombined = useOpenCombined();
  const markAllRead = useMarkAllRead();
  const several = accounts.length >= ALL_INBOXES_FROM;
  /** Moves the focus to the list a route shows, once it's there (so j/k work). */
  const focusList = (target: Route) => {
    const { listOrder, settings } = store.getState();
    const key = listKeyOf(target, listOrder, settings.conversations);
    focusWhenReady(MESSAGE_LIST_ID, {
      accept: (element) => element.dataset.listKey === key,
    });
  };

  const places: PaletteItem[] = [];
  const actions: PaletteItem[] = [];

  // ---- Places: combined views, then each account's mailboxes ------------
  if (several)
    for (const role of ["inbox", ...COMBINED_VIEWS] as const)
      places.push({
        id: `combined:${role}`,
        label: t.accounts.combined[role],
        detail: t.accounts.allAccounts,
        icon: ROLE_ICONS[role],
        section: "places",
        run: () => {
          if (openCombined(role)) focusList(router.getRoute());
        },
      });

  for (const handle of accounts) {
    const accountId = handle.account.id;
    const boxes = mailboxes.get(accountId)?.data ?? [];
    const names = roleNamesOf(boxes, handle.provider.capabilities);
    const name = (mailbox: Mailbox) => mailboxName(mailbox, t, names);
    const byId = new Map(boxes.map((mailbox) => [mailbox.id, mailbox]));
    const split = isSplit(
      boxes,
      store.getState().settings.focusedInbox[accountId],
    );
    for (const mailbox of boxes) {
      if (!mailbox.selectable) continue;
      // Focused and Other only while the Inbox is split; "back from
      // snooze" is a part of the Inbox, not a place.
      if (isFocusView(mailbox) && !split) continue;
      if (mailbox.standard === "backFromSnooze") continue;
      places.push({
        id: `mailbox:${accountId}:${mailbox.id}`,
        label: pathOf(mailbox, byId, name),
        detail: handle.account.email,
        icon: mailboxIcon(mailbox),
        section: "places",
        run: () => {
          const target = { accountId, mailboxId: mailbox.id };
          router.navigate(target);
          focusList(target);
        },
      });
    }
  }

  // ---- Calendar ----------------------------------------------------------
  const calendarViews: readonly (readonly [CalendarView, string])[] =
    breakpoint === "narrow"
      ? [
          ["day", t.shortcuts.calDay],
          ["agenda", t.shortcuts.calAgenda],
        ]
      : [
          ["day", t.shortcuts.calDay],
          ["week", t.shortcuts.calWeek],
          ["month", t.shortcuts.calMonth],
          ["agenda", t.shortcuts.calAgenda],
        ];
  const shownView = (): CalendarView =>
    router.getCalendarRoute()?.view ??
    (breakpoint === "narrow" ? "day" : store.getState().settings.calendarView);
  places.push({
    id: "calendar:today",
    label: t.calendar.today,
    detail: t.calendar.calendar,
    icon: "calendar",
    section: "places",
    run: () => {
      router.openCalendar({ view: shownView(), date: dayKey(new Date()) });
    },
  });
  for (const [view, label] of calendarViews)
    places.push({
      id: `calendar:${view}`,
      label,
      detail: t.calendar.calendar,
      icon: "calendar",
      section: "places",
      run: () => {
        if (breakpoint !== "narrow" && view !== "day")
          store.getState().updateSettings({ calendarView: view });
        router.openCalendar({
          view,
          date: router.getCalendarRoute()?.date ?? dayKey(new Date()),
        });
      },
    });

  // ---- Contacts ------------------------------------------------------------
  const openList = (list: string) => () => {
    router.openContacts({ list });
  };
  if (contactSources.length > 1)
    places.push({
      id: `contacts:${ALL_CONTACTS}`,
      label: t.contacts.allContacts,
      detail: t.calendar.contacts,
      icon: "users",
      section: "places",
      run: openList(ALL_CONTACTS),
    });
  for (const source of contactSources) {
    const snapshot = queryClient.getQueryData<ContactSnapshot>(
      queryKeys.contacts(source.key),
    );
    const books = snapshot?.addressBooks ?? [];
    const lists: { list: string; label: string; icon: IconName }[] = [
      {
        list: listToken({ kind: "source", source: source.key }),
        label:
          books.length === 1 && books[0]
            ? books[0].name
            : t.contacts.everyContact,
        icon: "book",
      },
      ...(books.length > 1
        ? books.map((book) => ({
            list: listToken({
              kind: "book",
              source: source.key,
              book: book.id,
            }),
            label: book.name,
            icon: "book" as const,
          }))
        : []),
      ...(snapshot?.groups ?? []).map((group) => ({
        list: listToken({ kind: "group", source: source.key, group: group.id }),
        label: group.name,
        icon: "tag" as const,
      })),
      ...(source.provider.capabilities.otherContacts
        ? [
            {
              list: listToken({ kind: "other", source: source.key }),
              label: t.contacts.otherContacts,
              icon: "users" as const,
            },
          ]
        : []),
    ];
    for (const { list, label, icon } of lists)
      places.push({
        id: `contacts:${list}`,
        label,
        detail: source.label,
        keywords: t.calendar.contacts,
        icon,
        section: "places",
        run: openList(list),
      });
  }

  // ---- Settings --------------------------------------------------------------
  for (const [sectionId, title] of sections)
    places.push({
      id: `settings:${sectionId}`,
      label: title,
      detail: t.layout.settings,
      icon: "settings",
      section: "places",
      run: () => {
        openSettingsAt(router, sectionId);
      },
    });

  // ---- Keyboard commands that apply now ---------------------------------------
  for (const command of registry.list()) {
    if (LEFT_OUT.test(command.id) || command.when?.() === false) continue;
    const [binding] = command.keys;
    actions.push({
      id: `command:${command.id}`,
      label: command.description,
      icon: COMMAND_ICONS[command.id] ?? "chevron-right",
      ...(binding
        ? { shortcut: formatBinding(binding, t.shortcuts.keys) }
        : {}),
      section: "actions",
      run: () => {
        command.run(new KeyboardEvent("keydown"));
      },
    });
  }

  // ---- Actions only the palette has -------------------------------------------
  actions.push({
    id: "action:add-account",
    label: t.accounts.addAccount,
    icon: "plus",
    section: "actions",
    run: () => {
      store.getState().setAddAccountOpen(true);
    },
  });
  for (const [mode, icon] of THEMES) {
    const name = {
      system: t.layout.themeSystem,
      light: t.layout.themeLight,
      dark: t.layout.themeDark,
    }[mode];
    actions.push({
      id: `action:theme-${mode}`,
      label: p.theme(name),
      icon,
      section: "actions",
      run: () => {
        store.getState().setTheme(mode);
      },
    });
  }

  const current = part === "mail" && route && !route.unified ? route : null;
  const currentBoxes = current
    ? mailboxes.get(current.accountId)?.data
    : undefined;
  const currentMailbox = currentBoxes?.find(
    (mailbox) => mailbox.id === current?.mailboxId,
  );
  const currentHandle = accounts.find(
    (handle) => handle.account.id === current?.accountId,
  );
  if (
    current &&
    !current.search &&
    currentMailbox &&
    currentHandle?.provider.capabilities.settableFlags.includes("seen") &&
    currentMailbox.role !== "drafts" &&
    currentMailbox.role !== "scheduled" &&
    currentMailbox.role !== "sent" &&
    (currentMailbox.counts?.unread ?? 1) > 0
  ) {
    const accountId = current.accountId;
    actions.push({
      id: "action:mark-all-read",
      label: t.menus.markAllRead,
      detail: mailboxName(
        currentMailbox,
        t,
        roleNamesOf(currentBoxes ?? [], currentHandle.provider.capabilities),
      ),
      icon: "mail-open",
      section: "actions",
      run: () => {
        markAllRead(accountId, currentMailbox);
      },
    });
  }

  for (const handle of accounts) {
    const accountId: AccountId = handle.account.id;
    const capabilities = handle.provider.capabilities;
    const boxes = mailboxes.get(accountId)?.data ?? [];
    const names = roleNamesOf(boxes, capabilities);
    if (capabilities.manageMailboxes)
      actions.push({
        id: `action:manage-labels:${accountId}`,
        label: mailboxTexts(t, capabilities).manageLabels,
        detail: handle.account.email,
        icon: capabilities.mailboxKinds.includes("folder") ? "folder" : "tag",
        section: "actions",
        run: () => {
          store.getState().setManageLabels(accountId);
        },
      });
    if (!capabilities.deleteForever) continue;
    for (const mailbox of boxes) {
      if (mailbox.role !== "trash" && mailbox.role !== "junk") continue;
      const name = mailboxName(mailbox, t, names);
      actions.push({
        id: `action:empty:${accountId}:${mailbox.id}`,
        label: t.actions.empty(name),
        detail: handle.account.email,
        icon: "trash",
        section: "actions",
        run: () => {
          const a = t.actions;
          store.getState().setConfirm({
            title: a.emptyTitle(name),
            message: a.emptyMessage(name),
            confirmLabel: a.empty(name),
            action: { kind: "empty", accountId, mailboxId: mailbox.id, name },
          });
        },
      });
    }
  }

  for (const source of contactSources)
    actions.push({
      id: `action:duplicates:${source.key}`,
      label: t.contacts.findDuplicates,
      detail: source.label,
      icon: "merge",
      section: "actions",
      run: () => {
        router.openContacts({
          list: listToken({ kind: "source", source: source.key }),
          duplicates: true,
        });
      },
    });

  // ---- Search mail ---------------------------------------------------------------
  const text = query.trim();
  const search: PaletteItem[] = text
    ? [
        {
          id: "search",
          label: p.searchMail(text),
          detail: p.everywhere,
          icon: "search",
          section: "search",
          remember: false,
          run: () => {
            const from = router.getRoute() ?? router.getLastMailRoute();
            const ids = accounts.map((handle) => handle.account.id);
            const combined = several
              ? combinedRoute(queryClient, ids, from, "inbox")
              : undefined;
            const accountId = from?.accountId ?? ids[0];
            const inbox =
              accountId &&
              mailboxes
                .get(accountId)
                ?.data?.find((mailbox) => mailbox.role === "inbox");
            const target =
              combined ??
              (accountId && inbox ? { accountId, mailboxId: inbox.id } : null);
            if (!target) return;
            router.navigate({ ...target, search: { text, everywhere: true } });
          },
        },
      ]
    : [];

  return [...places, ...actions, ...search];
}
