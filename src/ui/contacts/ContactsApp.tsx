import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { completeness, type Contact } from "../../core/contacts";
import {
  canChangeContact,
  contactKeyOf,
  contactRows,
  findContact,
  useContactsData,
  listToken,
  parseListToken,
  targetBook,
  writableBooks,
  type ContactList as ListSpec,
  type ContactRow,
  type ContactSource,
  type ContactSourceState,
} from "../../data/contacts";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useT } from "../../i18n/context";
import {
  useContactsRoute,
  useRouter,
  useUi,
  useUiStore,
} from "../../state/context";
import type { ContactsRoute } from "../../state/router";
import * as selection from "../../state/selection";
import type { MenuPosition } from "../../state/uiStore";
import { useAccountColors } from "../accounts/accountColors";
import { focusWhenReady } from "../common/focusWhenReady";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useAsk } from "../common/useAsk";
import { useComposeActions } from "../composer/useComposeActions";
import { Drawer } from "../layout/Drawer";
import { ResizableColumns } from "../layout/ResizableColumns";
import { useCoarsePointer, type Breakpoint } from "../layout/useBreakpoint";
import { ContactDetails } from "./ContactDetails";
import { ContactEditor, type EditorTarget } from "./ContactEditor";
import { CONTACT_SEARCH_ID, ContactList, type RowChoice } from "./ContactList";
import { ContactMenu, type ContactMenuHandlers } from "./ContactMenu";
import { ContactsSidebar } from "./ContactsSidebar";
import { DuplicatesDialog } from "./DuplicatesDialog";
import { ImportDialog } from "./ImportDialog";
import { useContactActions } from "./useContactActions";
import { useVcardFiles } from "./vcardFiles";

/** The contacts: shown while the URL names them. */
export function ContactsApp({ breakpoint }: { breakpoint: Breakpoint }) {
  const route = useContactsRoute();
  return route ? <Contacts route={route} breakpoint={breakpoint} /> : null;
}

/** What the editor is open for. */
type EditorSpec =
  | { readonly kind: "edit"; readonly key: string }
  | {
      readonly kind: "new";
      readonly prefill?: { readonly name?: string; readonly address?: string };
    };

const editorOf = (route: ContactsRoute): EditorSpec | null =>
  route.edit && route.contact !== undefined
    ? { kind: "edit", key: route.contact }
    : route.create
      ? { kind: "new", prefill: route.create }
      : null;

const hasFiles = (event: DragEvent) =>
  event.dataTransfer?.types.includes("Files") === true;

function Contacts({
  route,
  breakpoint,
}: {
  route: ContactsRoute;
  breakpoint: Breakpoint;
}) {
  const t = useT();
  const c = t.contacts;
  const router = useRouter();
  const store = useUiStore();
  const ask = useAsk();
  const actions = useContactActions();
  const files = useVcardFiles();
  const compose = useComposeActions();
  const colors = useAccountColors();
  const states = useContactsData();
  const contactSelection = useUi((state) => state.contactSelection);
  const importFile = useUi((state) => state.contactImport);
  const last = useUi((state) => state.settings.lastAddressBook);
  const coarse = useCoarsePointer();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState<{
    rows: readonly ContactRow[];
    at: MenuPosition;
    fromList: boolean;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importList = useRef(route.list);

  const list = useMemo(() => parseListToken(route.list), [route.list]);
  const search = route.search ?? "";
  const collator = useMemo(
    () => new Intl.Collator(t.locale, { sensitivity: "base", numeric: true }),
    [t.locale],
  );
  const rows = useMemo(
    () => contactRows(states, list, search, collator.compare),
    [states, list, search, collator],
  );
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const open = findContact(states, route.contact);
  const stateOf = useCallback(
    (key: string): ContactSourceState | undefined =>
      states.find((state) => state.source.key === key),
    [states],
  );
  const books = useMemo(() => writableBooks(states), [states]);
  const selected = contactSelection.selectedIds;

  /** The place with the same list and search, plus `next`. */
  const place = useCallback(
    (next: Partial<ContactsRoute> = {}): ContactsRoute => ({
      list: route.list,
      ...(route.search ? { search: route.search } : {}),
      ...next,
    }),
    [route.list, route.search],
  );

  // Another list: its own selection.
  useEffect(() => {
    store.getState().updateContactSelection(() => selection.EMPTY_SELECTION);
  }, [route.list, store]);

  const openRow = useCallback(
    (row: ContactRow) => {
      router.openContacts(place({ contact: row.key }), {
        // Side by side, going from contact to contact isn't a new place.
        replace: breakpoint !== "narrow" && route.contact !== undefined,
      });
    },
    [router, place, breakpoint, route.contact],
  );
  const closeContact = useCallback(() => {
    if (breakpoint === "narrow" && router.canGoBack()) router.back();
    else router.openContacts(place(), { replace: true });
  }, [breakpoint, router, place]);

  // ---- The editor ------------------------------------------------------
  const [editing, setEditing] = useState<EditorSpec | null>(() =>
    editorOf(route),
  );
  const dirty = useRef(false);
  const pushedEditor = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const editorRoute = (spec: EditorSpec): ContactsRoute =>
    spec.kind === "edit"
      ? place({ contact: spec.key, edit: true })
      : place({ create: spec.prefill ?? {} });
  const openEditor = (spec: EditorSpec) => {
    dirty.current = false;
    setEditing(spec);
    pushedEditor.current = true;
    router.openContacts(editorRoute(spec));
  };
  const closeEditor = () => {
    const spec = editing ?? editorOf(route);
    dirty.current = false;
    setEditing(null);
    if (pushedEditor.current && router.canGoBack()) router.back();
    else
      router.openContacts(
        spec?.kind === "edit" ? place({ contact: spec.key }) : place(),
        { replace: true },
      );
    pushedEditor.current = false;
  };
  const discard = () =>
    ask({
      title: c.discardTitle,
      message: c.discardMessage,
      cancelLabel: t.filters.keepEditing,
      options: [{ value: "discard", label: c.discard, tone: "danger" }],
    });
  const cancelEditor = () => {
    if (!dirty.current) {
      closeEditor();
      return;
    }
    void discard().then((answer) => {
      if (answer !== null) closeEditor();
    });
  };
  const onSaved = (source: ContactSource, contact: Contact) => {
    if ((editing ?? editorOf(route))?.kind === "new")
      store.getState().updateSettings({
        lastAddressBook: listToken({
          kind: "book",
          source: source.key,
          book: contact.addressBookId,
        }),
      });
    dirty.current = false;
    setEditing(null);
    pushedEditor.current = false;
    router.openContacts(
      place({ contact: contactKeyOf(source.key, contact.id) }),
      { replace: true },
    );
  };

  // Back takes the editor out of the URL first: with changes, it comes back and asks.
  const routeEditor = editorOf(route);
  const routeEditorKey = routeEditor ? JSON.stringify(routeEditor) : "";
  const shown = useRef(routeEditorKey);
  useEffect(() => {
    const before = shown.current;
    shown.current = routeEditorKey;
    if (editing && before && !routeEditorKey) {
      if (!dirty.current) {
        setEditing(null);
        pushedEditor.current = false;
        return;
      }
      const spec = editing;
      pushedEditor.current = true;
      router.openContacts(editorRoute(spec));
      void discard().then((answer) => {
        if (answer === null) return;
        dirty.current = false;
        setEditing(null);
        pushedEditor.current = false;
        router.back();
      });
    }
    // Only when the URL's editor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeEditorKey]);

  const newContact = () => {
    if (books.length === 0) {
      store.getState().showToast({ message: c.noWritableBook, tone: "error" });
      return;
    }
    openEditor({ kind: "new" });
  };
  const editRow = (row: ContactRow) => {
    openEditor({ kind: "edit", key: row.key });
  };

  /** The editor shown: the one opened here, or the one the URL names (a reload). */
  const active = editing ?? routeEditor;
  const editorTarget = ((): EditorTarget | undefined => {
    if (!active) return undefined;
    if (active.kind === "edit") {
      const row = findContact(states, active.key);
      if (!row) return undefined;
      return {
        kind: "edit",
        source: row.source,
        contact: row.contact,
        snapshot: stateOf(row.source.key)?.snapshot,
      };
    }
    const initial = targetBook(books, list, last);
    if (!initial) return undefined;
    return {
      kind: "new",
      books,
      initial,
      snapshotOf: (key) => stateOf(key)?.snapshot,
      ...(active.prefill ? { prefill: active.prefill } : {}),
    };
  })();

  // ---- Changes ---------------------------------------------------------
  const bySource = (targets: readonly ContactRow[]) => {
    const groups = new Map<string, ContactRow[]>();
    for (const row of targets)
      groups.set(row.source.key, [...(groups.get(row.source.key) ?? []), row]);
    return [...groups.values()];
  };
  const remove = async (targets: readonly ContactRow[]) => {
    const changeable = targets.filter((row) =>
      canChangeContact(stateOf(row.source.key), row.contact),
    );
    if (changeable.length === 0) return;
    const removed = new Set(changeable.map((row) => row.key));
    const next = selection.nextAfterRemoval(keys, removed);
    for (const group of bySource(changeable)) {
      const source = group[0]?.source;
      if (!source || !(await actions.ensureWritable(source))) return;
      await actions.remove(
        source,
        group.map((row) => row.contact),
      );
    }
    store.getState().updateContactSelection(() => selection.EMPTY_SELECTION);
    if (route.contact !== undefined && removed.has(route.contact)) {
      const nextRow = rows.find((row) => row.key === next);
      if (breakpoint !== "narrow" && nextRow)
        router.openContacts(place({ contact: nextRow.key }), {
          replace: true,
        });
      else closeContact();
    }
  };
  const merge = async (targets: readonly ContactRow[]) => {
    const source = targets[0]?.source;
    if (!source || targets.some((row) => row.source.key !== source.key)) {
      store.getState().showToast({ message: c.mergeOneAccount, tone: "error" });
      return;
    }
    if (!(await actions.ensureWritable(source))) return;
    const contacts = [...targets.map((row) => row.contact)].sort(
      (a, b) => completeness(b) - completeness(a),
    );
    const merged = await actions.merge(source, contacts);
    store.getState().updateContactSelection(() => selection.EMPTY_SELECTION);
    if (merged)
      router.openContacts(
        place({ contact: contactKeyOf(source.key, merged.id) }),
        { replace: route.contact !== undefined },
      );
  };
  const addOther = async (row: ContactRow) => {
    if (!(await actions.ensureWritable(row.source))) return;
    const added = await actions.addOther(row.source, row.contact);
    if (added)
      router.openContacts(
        {
          list: listToken({ kind: "source", source: row.source.key }),
          contact: contactKeyOf(row.source.key, added.id),
        },
        { replace: true },
      );
  };
  const exportRows = (targets: readonly ContactRow[]) => {
    const first = targets[0];
    void files.exportContacts(
      targets.map((row) => ({
        source: row.source,
        contact: row.contact,
        snapshot: stateOf(row.source.key)?.snapshot,
      })),
      targets.length === 1 && first ? first.name : c.exportFileName,
    );
  };

  const handlers: ContactMenuHandlers = {
    select: (row) => {
      store
        .getState()
        .updateContactSelection((state) => selection.toggle(state, row.key));
    },
    open: openRow,
    edit: editRow,
    remove: (targets) => {
      void remove(targets);
    },
    merge: (targets) => {
      void merge(targets);
    },
    exportRows,
    addOther: (row) => {
      void addOther(row);
    },
  };

  /** The rows a menu or an action on `row` is for: the selection if it's part of it. */
  const targetsOf = (row: ContactRow) =>
    selected.has(row.key)
      ? rows.filter((other) => selected.has(other.key))
      : [row];
  const selectedRows = rows.filter((row) => selected.has(row.key));
  /** What Delete and the like act on: the selection, else the open contact. */
  const current = () =>
    selectedRows.length > 0 ? selectedRows : open ? [open] : [];

  const onChoose = (row: ContactRow, how: RowChoice) => {
    const base = {
      ...store.getState().contactSelection,
      focusedId: route.contact ?? store.getState().contactSelection.focusedId,
    };
    const update = (next: selection.SelectionState<string>) => {
      store.getState().updateContactSelection(() => next);
    };
    if (how.shift) update(selection.selectRange(base, keys, row.key));
    else if (how.toggle) update(selection.toggle(base, row.key));
    else if (base.selectedIds.size > 0 && how.touch)
      update(selection.toggle(base, row.key));
    else {
      update(selection.focusOnly(base, row.key));
      openRow(row);
    }
  };

  // ---- Keys ------------------------------------------------------------
  const idle = active === null;
  const changeable = open
    ? canChangeContact(stateOf(open.source.key), open.contact)
    : false;
  useCommands(
    useMemo((): Command[] => {
      const group = "contacts";
      const step = (delta: number, extend: boolean) => () => {
        const state = {
          ...store.getState().contactSelection,
          focusedId: route.contact ?? null,
        };
        const next = extend
          ? selection.extendFocus(state, keys, delta)
          : selection.moveFocus(state, keys, delta);
        store.getState().updateContactSelection(() => next);
        const row = rows.find((candidate) => candidate.key === next.focusedId);
        if (row && row.key !== route.contact) openRow(row);
      };
      if (!idle) return [];
      return [
        {
          id: "contacts.next",
          group,
          description: t.shortcuts.conNext,
          keys: ["j", "ArrowDown"],
          run: step(1, false),
        },
        {
          id: "contacts.previous",
          group,
          description: t.shortcuts.conPrevious,
          keys: ["k", "ArrowUp"],
          run: step(-1, false),
        },
        {
          id: "contacts.extend-down",
          group,
          description: t.shortcuts.conExtendDown,
          keys: ["shift+j", "shift+ArrowDown"],
          run: step(1, true),
        },
        {
          id: "contacts.extend-up",
          group,
          description: t.shortcuts.conExtendUp,
          keys: ["shift+k", "shift+ArrowUp"],
          run: step(-1, true),
        },
        {
          id: "contacts.toggle",
          group,
          description: t.shortcuts.conToggle,
          keys: ["x"],
          when: () => route.contact !== undefined,
          run: () => {
            const key = route.contact;
            if (key !== undefined)
              store
                .getState()
                .updateContactSelection((state) =>
                  selection.toggle(state, key),
                );
          },
        },
        {
          id: "contacts.open",
          group,
          description: t.shortcuts.conOpen,
          keys: ["Enter", "o"],
          when: () => route.contact === undefined && rows.length > 0,
          run: () => {
            const anchor = store.getState().contactSelection.anchorId;
            const row =
              rows.find((candidate) => candidate.key === anchor) ?? rows[0];
            if (row) openRow(row);
          },
        },
        {
          id: "contacts.close",
          group,
          description: t.shortcuts.conClose,
          keys: ["Escape", "u"],
          run: () => {
            if (store.getState().contactSelection.selectedIds.size > 0)
              store
                .getState()
                .updateContactSelection((state) =>
                  selection.clearSelection(state),
                );
            else if (route.contact !== undefined) closeContact();
          },
        },
        {
          id: "contacts.search",
          group,
          description: t.shortcuts.conSearch,
          keys: ["/"],
          run: () => {
            if (breakpoint === "narrow" && route.contact !== undefined)
              closeContact();
            focusWhenReady(CONTACT_SEARCH_ID);
          },
        },
        {
          id: "contacts.new",
          group,
          description: t.shortcuts.conNew,
          keys: ["c"],
          run: newContact,
        },
        {
          id: "contacts.edit",
          group,
          description: t.shortcuts.conEdit,
          keys: ["e"],
          when: () => changeable,
          run: () => {
            if (open) editRow(open);
          },
        },
        {
          id: "contacts.delete",
          group,
          description: t.shortcuts.conDelete,
          keys: ["Delete"],
          when: () => current().length > 0,
          run: () => {
            void remove(current());
          },
        },
      ];
      // The functions it calls change with what's listed and open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idle, route, rows, keys, open, changeable, selected, breakpoint, t]),
  );

  // ---- Files dropped on the contacts: imported ---------------------------
  useEffect(() => {
    importList.current = route.list;
  });
  useEffect(() => {
    if (!files.available) return;
    const onDrop = (event: DragEvent) => {
      // Files for an open composer stay its attachments.
      if (
        !hasFiles(event) ||
        (event.target instanceof Element &&
          event.target.closest("[data-own-keys]"))
      )
        return;
      // Before the app's own handler, which would start a mail with them.
      event.preventDefault();
      void files.importFiles(
        Array.from(event.dataTransfer?.files ?? []),
        importList.current,
      );
    };
    window.addEventListener("drop", onDrop, { capture: true });
    return () => {
      window.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [files]);

  // A reload can't bring the file of an import back.
  useEffect(() => {
    if (route.importing && !importFile) {
      const { importing: _importing, ...rest } = route;
      router.openContacts(rest, { replace: true });
    }
  }, [route, importFile, router]);

  // ---- Layout ----------------------------------------------------------
  const listLabel = (() => {
    if (list.kind === "all") return c.allContacts;
    const state = stateOf(list.source);
    const snapshot = state?.snapshot;
    if (list.kind === "other") return c.otherContacts;
    if (list.kind === "group")
      return (
        snapshot?.groups.find((group) => group.id === list.group)?.name ??
        c.contacts
      );
    if (list.kind === "book")
      return (
        snapshot?.addressBooks.find((book) => book.id === list.book)?.name ??
        c.contacts
      );
    return state?.source.label ?? c.contacts;
  })();
  const loading = states.some((state) => state.pending && !state.snapshot);
  const status = (
    <p className="text-sm text-zinc-500" role="status">
      {loading ? c.loading : search ? c.noMatches : c.noContacts}
    </p>
  );
  const sourceOf = (spec: ListSpec) =>
    spec.kind === "all" ? undefined : stateOf(spec.source);

  const sidebar = (onNavigate?: () => void) => (
    <ContactsSidebar
      states={states}
      list={list}
      {...(onNavigate ? { onNavigate } : {})}
      handlers={{
        newContact,
        importInto: (source) => {
          const state = stateOf(source.key);
          const book =
            state?.snapshot?.addressBooks.find((entry) => entry.isDefault) ??
            state?.snapshot?.addressBooks[0];
          importList.current = book
            ? listToken({ kind: "book", source: source.key, book: book.id })
            : listToken({ kind: "source", source: source.key });
          fileInput.current?.click();
        },
        exportSource: (source) => {
          const snapshot = stateOf(source.key)?.snapshot;
          void files.exportContacts(
            (snapshot?.contacts ?? []).map((contact) => ({
              source,
              contact,
              snapshot,
            })),
            source.label,
          );
        },
        findDuplicates: (source) => {
          router.openContacts({
            list: listToken({ kind: "source", source: source.key }),
            duplicates: true,
          });
        },
      }}
    />
  );

  const listPane = (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
        {breakpoint !== "wide" && (
          <IconButton
            label={c.showAddressBooks}
            icon="menu"
            onClick={() => {
              setDrawer(true);
            }}
          />
        )}
        <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
          {listLabel}
        </h2>
        <span className="px-1 text-xs text-zinc-500 tabular-nums">
          {c.count(
            new Intl.NumberFormat(t.locale).format(rows.length),
            rows.length,
          )}
        </span>
        {breakpoint === "medium" && (
          <IconButton
            label={c.newContact}
            icon="user-plus"
            onClick={newContact}
          />
        )}
      </div>
      <div className="relative shrink-0 px-3 py-2">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-zinc-400"
        />
        <input
          id={CONTACT_SEARCH_ID}
          type="search"
          aria-label={c.searchLabel}
          placeholder={c.searchPlaceholder}
          value={search}
          onChange={(event) => {
            const text = event.target.value;
            router.openContacts(
              {
                list: route.list,
                ...(route.contact !== undefined && breakpoint !== "narrow"
                  ? { contact: route.contact }
                  : {}),
                ...(text ? { search: text } : {}),
              },
              { replace: true },
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur();
            } else if (event.key === "ArrowDown" || event.key === "Enter") {
              const first = rows[0];
              if (!first) return;
              event.preventDefault();
              openRow(first);
              event.currentTarget.blur();
            }
          }}
          className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pr-2 pl-8 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11"
        />
      </div>
      {selectedRows.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-y border-zinc-200 bg-blue-50 px-2 py-1 dark:border-zinc-800 dark:bg-blue-500/10">
          <span className="flex-1 px-2 text-sm font-medium">
            {c.selected(selectedRows.length)}
          </span>
          {selectedRows.some((row) => row.contact.emails.length > 0) && (
            <IconButton
              label={c.writeToAll(selectedRows.length)}
              icon="mail"
              onClick={() => {
                compose.composeTo(
                  undefined,
                  selectedRows.flatMap((row) => {
                    const address = row.contact.emails[0]?.value;
                    return address
                      ? [{ address, ...(row.name ? { name: row.name } : {}) }]
                      : [];
                  }),
                );
              }}
            />
          )}
          {selectedRows.length > 1 &&
            selectedRows.every(
              (row) =>
                row.source.key === selectedRows[0]?.source.key &&
                canChangeContact(stateOf(row.source.key), row.contact),
            ) && (
              <IconButton
                label={c.merge}
                icon="merge"
                onClick={() => {
                  void merge(selectedRows);
                }}
              />
            )}
          {files.available && (
            <IconButton
              label={c.exportContacts}
              icon="download"
              onClick={() => {
                exportRows(selectedRows);
              }}
            />
          )}
          {selectedRows.every((row) =>
            canChangeContact(stateOf(row.source.key), row.contact),
          ) && (
            <IconButton
              label={c.delete}
              icon="trash"
              onClick={() => {
                void remove(selectedRows);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              store
                .getState()
                .updateContactSelection((state) =>
                  selection.clearSelection(state),
                );
            }}
            className="rounded-md px-2 py-1 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-500/20 pointer-coarse:min-h-11"
          >
            {c.done}
          </button>
        </div>
      )}
      <ContactList
        label={listLabel}
        rows={rows}
        openKey={route.contact}
        selected={selected}
        colors={list.kind === "all" && states.length > 1 ? colors : null}
        status={status}
        onChoose={onChoose}
        onMenu={(row, at) => {
          setMenu({ rows: targetsOf(row), at, fromList: true });
        }}
      />
    </div>
  );

  const details = open ? (
    <ContactDetails
      key={open.key}
      row={open}
      snapshot={stateOf(open.source.key)?.snapshot}
      breakpoint={breakpoint}
      canEdit={canChangeContact(stateOf(open.source.key), open.contact)}
      onClose={closeContact}
      onEdit={() => {
        editRow(open);
      }}
      onDelete={() => {
        void remove([open]);
      }}
      onAddOther={() => {
        void addOther(open);
      }}
      onMenu={(at) => {
        setMenu({ rows: [open], at, fromList: false });
      }}
    />
  ) : (
    <div className="grid h-full place-items-center bg-white text-zinc-300 dark:bg-zinc-950 dark:text-zinc-700">
      <Icon name="users" className="size-16" />
    </div>
  );

  let content;
  if (breakpoint === "wide")
    content = (
      <ResizableColumns
        columns={[
          {
            id: "sources",
            label: c.contacts,
            widthIndex: 0,
            content: sidebar(),
          },
          { id: "list", label: listLabel, widthIndex: 1, content: listPane },
          { id: "contact", label: open?.name || c.contacts, content: details },
        ]}
      />
    );
  else if (breakpoint === "medium")
    content = (
      <ResizableColumns
        columns={[
          { id: "list", label: listLabel, widthIndex: 1, content: listPane },
          { id: "contact", label: open?.name || c.contacts, content: details },
        ]}
      />
    );
  else
    content = (
      <div className="min-h-0 min-w-0 flex-1">{open ? details : listPane}</div>
    );

  const duplicatesOf = route.duplicates ? sourceOf(list) : undefined;

  return (
    <>
      {breakpoint !== "wide" && (
        <Drawer
          open={drawer}
          label={c.contacts}
          onClose={() => {
            setDrawer(false);
          }}
        >
          {sidebar(() => {
            setDrawer(false);
          })}
        </Drawer>
      )}
      {content}
      {breakpoint === "narrow" && !open && !drawer && (
        <button
          type="button"
          aria-label={c.newContact}
          onClick={newContact}
          className="fixed right-4 bottom-[calc(1.5rem+var(--safe-bottom))] z-30 grid size-14 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg"
        >
          <Icon name="user-plus" className="size-6" />
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".vcf,.vcard,text/vcard,text/x-vcard"
        multiple
        hidden
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          event.target.value = "";
          void files.importFiles(chosen, importList.current);
        }}
      />
      {editorTarget && (
        <ContactEditor
          key={active?.kind === "edit" ? active.key : "new"}
          target={editorTarget}
          onDirty={onDirty}
          onCancel={cancelEditor}
          onSaved={onSaved}
        />
      )}
      {duplicatesOf && (
        <DuplicatesDialog
          state={duplicatesOf}
          onClose={() => {
            if (router.canGoBack()) router.back();
            else router.openContacts({ list: route.list }, { replace: true });
          }}
        />
      )}
      {route.importing && importFile && (
        <ImportDialog
          file={importFile}
          states={states}
          onClose={() => {
            store.getState().setContactImport(null);
            if (router.canGoBack()) router.back();
            else router.openContacts(place(), { replace: true });
          }}
        />
      )}
      {menu && (
        <ContactMenu
          rows={menu.rows}
          at={menu.at}
          states={states}
          fromList={menu.fromList}
          touch={breakpoint === "narrow" || coarse}
          canExport={files.available}
          handlers={handlers}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
