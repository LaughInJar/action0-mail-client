import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCalendarSources } from "../../data/calendar";
import { useCalendarServers } from "../../data/calendarServers";
import {
  listToken,
  type ContactList,
  type ContactSource,
  type ContactSourceState,
} from "../../data/contacts";
import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { useAccountColors } from "../accounts/accountColors";
import { CalendarServerDialog } from "../calendar/CalendarServerDialog";
import { ContextMenu } from "../common/ContextMenu";
import { errorMessage } from "../common/errorMessage";
import { Icon, type IconName } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { belowElement } from "../common/menuPosition";
import { AppSwitch } from "../layout/AppSwitch";
import { ThemeSwitch } from "../layout/ThemeSwitch";
import { APP_TITLE } from "../sync/useDocumentTitle";

/** What the column's menus do, which needs the contacts' screen. */
export interface SidebarHandlers {
  readonly newContact: () => void;
  readonly importInto: (source: ContactSource) => void;
  readonly exportSource: (source: ContactSource) => void;
  readonly findDuplicates: (source: ContactSource) => void;
}

/**
 * The contacts' column: the app's header and switch, New contact, All
 * contacts, and every source with its address books, groups and (Google)
 * Other contacts. Sources that can't show their contacts yet offer Allow
 * contacts or Set up calendar and contacts.
 */
export function ContactsSidebar({
  states,
  list,
  handlers,
  onNavigate,
}: {
  states: readonly ContactSourceState[];
  list: ContactList;
  handlers: SidebarHandlers;
  /** Called after navigating (closes the drawer). */
  onNavigate?: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const router = useRouter();
  const calendarServers = useCalendarServers();
  const calendarSources = useCalendarSources();
  const [setUp, setSetUp] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    source: ContactSource;
    at: MenuPosition;
  } | null>(null);
  const current = listToken(list);
  const go = (target: ContactList) => {
    onNavigate?.();
    router.openContacts({ list: listToken(target) });
  };
  const total = states.reduce(
    (sum, state) => sum + (state.snapshot?.contacts.length ?? 0),
    0,
  );
  const serverSource = setUp
    ? calendarSources.find((source) => source.key === setUp)
    : undefined;

  return (
    <nav
      aria-label={c.contacts}
      className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 pt-2 pr-2 pb-1 pl-4 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <Icon name="mail" className="size-5 text-blue-600 dark:text-blue-400" />
        <span className="flex-1">{APP_TITLE}</span>
        <ThemeSwitch />
        <IconButton
          label={t.layout.settings}
          icon="settings"
          onClick={() => {
            onNavigate?.();
            router.openSettings();
          }}
        />
      </div>
      <AppSwitch {...(onNavigate ? { onNavigate } : {})} />
      <div className="px-2 pt-1 pb-2">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            handlers.newContact();
          }}
          className="flex w-full items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 pointer-coarse:min-h-11"
        >
          <Icon name="user-plus" className="size-4" />
          <span className="flex-1 text-left">{c.newContact}</span>
          <kbd className="font-sans text-xs font-normal opacity-75 pointer-coarse:hidden">
            c
          </kbd>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {states.length === 0 && (
          <p className="px-2 py-2 text-sm text-zinc-500">{c.noSources}</p>
        )}
        {states.length > 1 && (
          <Entry
            icon="users"
            label={c.allContacts}
            count={total}
            current={current === "all"}
            onClick={() => {
              go({ kind: "all" });
            }}
          />
        )}
        {states.map((state) => (
          <SourceSection
            key={state.source.key}
            state={state}
            current={current}
            onGo={go}
            onSetUp={() => {
              setSetUp(state.source.key);
            }}
            onMenu={(at) => {
              setMenu({ source: state.source, at });
            }}
          />
        ))}
        {!calendarServers && (
          <p className="px-2 pt-3 text-[0.7rem] text-zinc-500">{c.appsOnly}</p>
        )}
      </div>
      {menu && (
        <ContextMenu
          label={c.moreFor(menu.source.label)}
          title={menu.source.label}
          at={menu.at}
          entries={[
            {
              id: "import",
              label: c.importFile,
              icon: "upload",
              run: () => {
                handlers.importInto(menu.source);
              },
            },
            {
              id: "export",
              label: c.exportContacts,
              icon: "download",
              run: () => {
                handlers.exportSource(menu.source);
              },
            },
            {
              id: "duplicates",
              label: c.findDuplicates,
              icon: "merge",
              run: () => {
                onNavigate?.();
                handlers.findDuplicates(menu.source);
              },
            },
          ]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {/* On the page itself: in the phones' drawer, a dialog would only be as wide as the drawer. */}
      {serverSource &&
        createPortal(
          <CalendarServerDialog
            source={serverSource}
            onClose={() => {
              setSetUp(null);
            }}
          />,
          document.body,
        )}
    </nav>
  );
}

function SourceSection({
  state,
  current,
  onGo,
  onSetUp,
  onMenu,
}: {
  state: ContactSourceState;
  current: string;
  onGo: (list: ContactList) => void;
  onSetUp: () => void;
  onMenu: (at: MenuPosition) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const store = useUiStore();
  const colors = useAccountColors();
  const moreRef = useRef<HTMLDivElement>(null);
  const [allowing, setAllowing] = useState(false);
  const { source, signedIn, access, snapshot, error, pending } = state;
  const color = source.accountId ? colors.get(source.accountId) : undefined;
  const books = snapshot?.addressBooks ?? [];
  const groups = snapshot?.groups ?? [];
  const contacts = snapshot?.contacts ?? [];

  const allow = () => {
    setAllowing(true);
    source.provider.requestAccess().then(
      () => {
        setAllowing(false);
      },
      (cause: unknown) => {
        setAllowing(false);
        store.getState().showToast({
          message: errorMessage(cause, t),
          tone: "error",
        });
      },
    );
  };

  const token = (list: ContactList) => listToken(list);
  const sourceList: ContactList = { kind: "source", source: source.key };

  return (
    <section aria-label={source.label} className="pt-3">
      <div className="flex items-center gap-1.5 px-2">
        {color && (
          <span
            aria-hidden="true"
            style={{ backgroundColor: color }}
            className="size-2 shrink-0 rounded-full"
          />
        )}
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-500">
          {source.label}
        </h3>
        {snapshot && (
          <div ref={moreRef}>
            <IconButton
              label={c.moreFor(source.label)}
              icon="more"
              onClick={() => {
                if (moreRef.current) onMenu(belowElement(moreRef.current));
              }}
            />
          </div>
        )}
      </div>
      {!signedIn && (
        <p className="px-2 py-1 text-xs text-zinc-500">{c.reconnectFirst}</p>
      )}
      {signedIn && access === "missing" && (
        <div className="space-y-1 px-2 py-1">
          <p className="text-xs text-zinc-500">
            {source.provider.setup === "server" ? c.setUpHint : c.allowHint}
          </p>
          <button
            type="button"
            disabled={allowing}
            onClick={() => {
              if (source.provider.setup === "server") onSetUp();
              else allow();
            }}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {source.provider.setup === "server" ? c.setUp : c.allowContacts}
          </button>
        </div>
      )}
      {signedIn && access !== "missing" && pending && !snapshot && (
        <p className="px-2 py-1 text-xs text-zinc-500">{c.loading}</p>
      )}
      {signedIn &&
        access !== "missing" &&
        error !== null &&
        error !== undefined && (
          <p
            role="alert"
            className="px-2 py-1 text-xs text-red-700 dark:text-red-400"
          >
            {c.couldntLoad(errorMessage(error, t))}
          </p>
        )}
      {snapshot && (
        <ul>
          <li>
            <Entry
              icon="book"
              label={
                books.length === 1 && books[0] ? books[0].name : c.everyContact
              }
              count={contacts.length}
              current={current === token(sourceList)}
              onClick={() => {
                onGo(sourceList);
              }}
            />
          </li>
          {books.length > 1 &&
            books.map((book) => {
              const list: ContactList = {
                kind: "book",
                source: source.key,
                book: book.id,
              };
              return (
                <li key={book.id}>
                  <Entry
                    icon="book"
                    label={book.name}
                    note={
                      book.readOnly && access === "granted"
                        ? c.readOnlyBook
                        : undefined
                    }
                    count={
                      contacts.filter(
                        (contact) => contact.addressBookId === book.id,
                      ).length
                    }
                    current={current === token(list)}
                    indent
                    onClick={() => {
                      onGo(list);
                    }}
                  />
                </li>
              );
            })}
          {groups.map((group) => {
            const list: ContactList = {
              kind: "group",
              source: source.key,
              group: group.id,
            };
            return (
              <li key={group.id}>
                <Entry
                  icon="tag"
                  {...(group.color ? { color: group.color } : {})}
                  label={group.name}
                  count={
                    contacts.filter((contact) =>
                      contact.groupIds.includes(group.id),
                    ).length
                  }
                  current={current === token(list)}
                  onClick={() => {
                    onGo(list);
                  }}
                />
              </li>
            );
          })}
          {source.provider.capabilities.otherContacts && (
            <li>
              <Entry
                icon="user"
                label={c.otherContacts}
                count={snapshot.other?.length ?? 0}
                current={
                  current === token({ kind: "other", source: source.key })
                }
                onClick={() => {
                  onGo({ kind: "other", source: source.key });
                }}
              />
            </li>
          )}
        </ul>
      )}
      {snapshot && access === "readOnly" && (
        <p className="px-2 pt-1 text-[0.7rem] text-zinc-500">
          {c.readOnlyHint}
        </p>
      )}
    </section>
  );
}

function Entry({
  icon,
  label,
  count,
  current,
  onClick,
  indent = false,
  color,
  note,
}: {
  icon: IconName;
  label: string;
  count: number;
  current: boolean;
  onClick: () => void;
  indent?: boolean;
  color?: string;
  note?: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-sm hover:bg-zinc-200/60 aria-[current=page]:bg-blue-100 aria-[current=page]:font-medium aria-[current=page]:text-blue-900 dark:hover:bg-zinc-800 dark:aria-[current=page]:bg-blue-500/20 dark:aria-[current=page]:text-blue-100 pointer-coarse:min-h-11 ${indent ? "pl-6" : "pl-2"}`}
    >
      <Icon
        name={icon}
        className="size-4 shrink-0 text-zinc-500 dark:text-zinc-400"
        {...(color ? { style: { color } } : {})}
      />
      <span className="min-w-0 flex-1 truncate">
        {label}
        {note && <span className="ml-1 text-xs text-zinc-500">({note})</span>}
      </span>
      <span className="text-xs text-zinc-500 tabular-nums">{count}</span>
    </button>
  );
}
