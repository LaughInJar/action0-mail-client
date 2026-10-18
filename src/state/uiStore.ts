import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerContent } from "../compose/session";
import type { AccountId, DraftId, MailboxId, MessageId } from "../core/ids";
import type { MailIntent } from "../core/intents";
import type { MessageSummary, Unsubscribe } from "../core/model";
import type { MessageOrder } from "../core/provider";
import * as selection from "./selection";
import { readTheme, saveTheme, type ThemeMode } from "./theme";
import {
  DEFAULT_SETTINGS,
  MAX_TRUSTED_SENDERS,
  parseSettings,
  type AppSettings,
} from "./settings";

/** A short notification at the bottom of the screen, optionally undoable. */
export interface Toast {
  readonly id: number;
  /** When it was shown (epoch ms); `z` undoes the most recent action. */
  readonly createdAt: number;
  readonly message: string;
  readonly tone: "info" | "error";
  /** A discarded draft that "Undo" brings back. */
  readonly restoreDraft?: ComposerSession;
  /** Intents that revert the action the toast reports. */
  readonly undo?: {
    readonly accountId: AccountId;
    readonly intents: readonly MailIntent[];
    /** The messages as the action left them, for messages that left every cached list. */
    readonly known: readonly MessageSummary[];
  };
  /** Reverts the action the toast reports (changes that aren't mail intents). */
  readonly revert?: () => void;
  /** A link the toast offers, opened in a new tab. */
  readonly link?: { readonly label: string; readonly href: string };
}

/** Messages being dragged (`dragover` handlers can't read the drag data). */
export interface DragState {
  readonly accountId: AccountId;
  readonly ids: readonly MessageId[];
}

/** The open mailbox picker and the messages it acts on (captured when it opened). */
export interface PickerState {
  readonly mode: "move" | "labels";
  readonly accountId: AccountId;
  /** Rows of the list: messages, or conversations (by their oldest message). */
  readonly ids: readonly MessageId[];
  /** The rows are conversations. */
  readonly conversations?: boolean;
}

/** A destructive action waiting for the user's confirmation. */
export interface ConfirmState {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly action:
    | {
        readonly kind: "delete-forever";
        readonly accountId: AccountId;
        readonly ids: readonly MessageId[];
      }
    | {
        readonly kind: "empty";
        readonly accountId: AccountId;
        readonly mailboxId: MailboxId;
        readonly name: string;
      }
    | {
        readonly kind: "unsubscribe";
        readonly accountId: AccountId;
        readonly messageId: MessageId;
        /** Who the user unsubscribes from, for messages. */
        readonly sender: string;
        readonly unsubscribe: Unsubscribe;
      }
    | {
        readonly kind: "delete-label";
        readonly accountId: AccountId;
        readonly mailboxId: MailboxId;
        readonly name: string;
      };
}

/** A confirmed action of {@link ConfirmState}. */
export type ConfirmAction = ConfirmState["action"];

/** Confirmed actions on messages (see `useMailActions`). */
export type MailConfirmAction = Extract<
  ConfirmAction,
  { readonly kind: "delete-forever" | "empty" }
>;

/** The open label menu (in the folder tree) and where it shows. */
export interface LabelMenuState {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  /** Viewport position of the menu's left edge. */
  readonly x: number;
  /** Where its top goes, when it fits below that. */
  readonly y: number;
  /** Where its bottom goes otherwise (above what it belongs to). */
  readonly flipY: number;
}

/** The open label dialog: a new label, or changes to one. */
export type LabelDialogState =
  | {
      readonly mode: "create";
      readonly accountId: AccountId;
      readonly parentId?: MailboxId;
    }
  | {
      readonly mode: "edit";
      readonly accountId: AccountId;
      readonly mailboxId: MailboxId;
      /** Field that gets focus. */
      readonly focus: "name" | "parent" | "color";
    };

/** How a composer was started. */
export type ComposerKind = "new" | "reply" | "reply-all" | "forward" | "draft";

/** A mail being written. Memory only, never persisted. */
export interface ComposerSession extends ComposerContent {
  /** Identifies this session; every opened mail gets a new one. */
  readonly key: number;
  readonly accountId: AccountId;
  readonly kind: ComposerKind;
  /** The saved draft, once there is one. */
  readonly draftId?: DraftId;
  readonly showCcBcc: boolean;
  readonly window: "docked" | "minimized" | "expanded";
  /** Field that gets focus when the composer opens. */
  readonly focus: "to" | "body";
  /** Bumped by every edit of the content. */
  readonly revision: number;
  /** The revision saved as the draft (equal to `revision`: nothing to save). */
  readonly savedRevision: number;
  readonly saving: boolean;
  readonly saveError?: string;
}

/**
 * What {@link UiActions.openComposer} needs; the rest gets defaults. Pass
 * the `key` of an earlier session to continue it (undo send, undo discard),
 * and `dirty` if its content still needs saving.
 */
export type ComposerInit = Pick<ComposerSession, "accountId" | "kind"> &
  Partial<
    Omit<ComposerSession, "revision" | "savedRevision" | "saving" | "saveError">
  > & { readonly dirty?: boolean };

/** A sent mail waiting out its undo period. */
export interface PendingSend {
  readonly id: number;
  readonly session: ComposerSession;
  readonly queuedAt: number;
  readonly sendAt: number;
}

/** UI state that isn't server data and isn't in the URL. */
export interface UiState extends selection.SelectionState {
  /** Identifies the list that focus and selection belong to (mailbox, search and order). */
  readonly listKey: string | null;
  /** Date order of message lists. Persisted. */
  readonly listOrder: MessageOrder;
  /** Colour theme. Persisted under its own key (see `state/theme.ts`). */
  readonly theme: ThemeMode;
  /** App settings. Persisted. */
  readonly settings: AppSettings;
  /**
   * The message at the cursor of the open conversation (conversation view):
   * what `n`/`p` move and `r`/`f` answer. Session only.
   */
  readonly readerCursor: MessageId | null;
  /** Text of the folder filter above the tree. Session only. */
  readonly folderFilter: string;
  /** Messages whose remote content the user allowed. Session only. */
  readonly remoteContentAllowed: ReadonlySet<MessageId>;
  /** Widths (px) of the tree and the list column. Persisted. */
  readonly columnWidths: readonly [number, number];
  /** Tree nodes whose expansion differs from their default. Persisted. */
  readonly toggledNodes: ReadonlySet<string>;
  readonly drawerOpen: boolean;
  readonly helpOpen: boolean;
  /** The current toast. Session only. */
  readonly toast: Toast | null;
  readonly dragging: DragState | null;
  readonly picker: PickerState | null;
  readonly confirm: ConfirmState | null;
  /** The Add account dialog is open. */
  readonly addAccountOpen: boolean;
  /** The open composer. */
  readonly composer: ComposerSession | null;
  /** Sent mails within their undo period, oldest first. */
  readonly pendingSends: readonly PendingSend[];
  /** Messages whose list the user left in this session. Session only. */
  readonly unsubscribed: ReadonlySet<MessageId>;
  readonly labelMenu: LabelMenuState | null;
  readonly labelDialog: LabelDialogState | null;
  /** The account whose labels "Manage labels" shows. */
  readonly manageLabels: AccountId | null;
}

/** State transitions. */
export interface UiActions {
  /** Switches to another list; resets the selection and focuses `focusedId`. */
  readonly enterList: (listKey: string, focusedId: MessageId | null) => void;
  readonly focusOnly: (id: MessageId) => void;
  readonly moveFocus: (orderedIds: readonly MessageId[], delta: number) => void;
  readonly focusAt: (orderedIds: readonly MessageId[], index: number) => void;
  readonly toggle: (id: MessageId) => void;
  readonly selectRange: (
    orderedIds: readonly MessageId[],
    id: MessageId,
  ) => void;
  readonly extendFocus: (
    orderedIds: readonly MessageId[],
    delta: number,
  ) => void;
  readonly clearSelection: () => void;
  /** Messages left the list (moved, archived): see {@link selection.removeFromList}. */
  readonly removeFromList: (
    removed: ReadonlySet<MessageId>,
    next: MessageId | null,
    options?: { readonly open?: boolean },
  ) => void;
  readonly allowRemoteContent: (id: MessageId) => void;
  readonly setColumnWidth: (index: 0 | 1, width: number) => void;
  readonly setListOrder: (order: MessageOrder) => void;
  readonly setTheme: (theme: ThemeMode) => void;
  readonly setReaderCursor: (id: MessageId | null) => void;
  readonly updateSettings: (patch: Partial<AppSettings>) => void;
  /** Remote images of this sender load without asking (in "trusted" mode). */
  readonly trustSender: (address: string) => void;
  readonly untrustSender: (address: string) => void;
  readonly setFolderFilter: (text: string) => void;
  readonly toggleNode: (key: string) => void;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly setHelpOpen: (open: boolean) => void;
  /** Shows a toast, replacing the current one. */
  readonly showToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
  /** Hides the toast with this id (if it is still the current one). */
  readonly dismissToast: (id: number) => void;
  readonly setDragging: (dragging: DragState | null) => void;
  readonly setPicker: (picker: PickerState | null) => void;
  readonly setConfirm: (confirm: ConfirmState | null) => void;
  readonly setAddAccountOpen: (open: boolean) => void;
  /** Opens a composer (replacing any open one) and returns its session. */
  readonly openComposer: (init: ComposerInit) => ComposerSession;
  /**
   * Changes the composer with this key. `edit` marks a content change that
   * needs saving.
   */
  readonly updateComposer: (
    key: number,
    patch: Partial<
      ComposerContent & Pick<ComposerSession, "showCcBcc" | "window" | "focus">
    >,
    edit: boolean,
  ) => void;
  readonly markComposerSaving: (key: number) => void;
  /** A save of `revision` finished (or failed, with `error`). */
  readonly markComposerSaved: (
    key: number,
    result: { revision: number; draftId: DraftId } | { error: string },
  ) => void;
  /** Closes the composer (if it is still the one with `key`). */
  readonly closeComposer: (key: number) => void;
  /** Moves the composer into the send queue. */
  readonly queueSend: (key: number, delayMs: number) => PendingSend | undefined;
  /** Removes a pending send (sent, failed or undone) and returns it. */
  readonly takePendingSend: (id: number) => PendingSend | undefined;
  readonly markUnsubscribed: (id: MessageId) => void;
  readonly setLabelMenu: (menu: LabelMenuState | null) => void;
  readonly setLabelDialog: (dialog: LabelDialogState | null) => void;
  readonly setManageLabels: (accountId: AccountId | null) => void;
}

export type UiStore = StoreApi<UiState & UiActions>;

/** localStorage key of the persisted UI state. */
export const UI_STATE_KEY = "a0.ui";

/** Allowed widths of the tree (index 0) and list (index 1) columns. */
export const COLUMN_LIMITS = [
  { min: 180, max: 480, initial: 248 },
  { min: 280, max: 720, initial: 400 },
] as const;

const clampWidth = (index: 0 | 1, width: number) =>
  Math.round(
    Math.min(
      COLUMN_LIMITS[index].max,
      Math.max(COLUMN_LIMITS[index].min, width),
    ),
  );

const noStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

interface PersistedUi {
  columnWidths?: unknown;
  toggledNodes?: unknown;
  listOrder?: unknown;
  settings?: unknown;
}

/**
 * Creates the UI store. Only column widths, tree expansion, the list order,
 * the theme and the app settings are persisted (to `storage`, i.e.
 * localStorage); nothing that contains mail (trusted senders are addresses
 * the user chose to trust, kept like a setting).
 */
export function createUiStore(storage: Storage | undefined): UiStore {
  return createStore<UiState & UiActions>()(
    persist(
      (set, get) => {
        let sequence = 0;
        const update = (
          fn: (state: selection.SelectionState) => selection.SelectionState,
        ) => {
          set((state) => fn(state));
        };
        return {
          ...selection.EMPTY_SELECTION,
          listKey: null,
          remoteContentAllowed: new Set(),
          columnWidths: [COLUMN_LIMITS[0].initial, COLUMN_LIMITS[1].initial],
          toggledNodes: new Set(),
          listOrder: "newest",
          theme: readTheme(storage),
          settings: DEFAULT_SETTINGS,
          readerCursor: null,
          folderFilter: "",
          drawerOpen: false,
          helpOpen: false,
          toast: null,
          dragging: null,
          picker: null,
          confirm: null,
          addAccountOpen: false,
          composer: null,
          pendingSends: [],
          unsubscribed: new Set(),
          labelMenu: null,
          labelDialog: null,
          manageLabels: null,

          enterList: (listKey, focusedId) => {
            set({
              ...selection.EMPTY_SELECTION,
              listKey,
              focusedId,
              anchorId: focusedId,
            });
          },
          focusOnly: (id) => {
            update((s) => selection.focusOnly(s, id));
          },
          moveFocus: (ids, delta) => {
            update((s) => selection.moveFocus(s, ids, delta));
          },
          focusAt: (ids, index) => {
            update((s) => selection.focusAt(s, ids, index));
          },
          toggle: (id) => {
            update((s) => selection.toggle(s, id));
          },
          selectRange: (ids, id) => {
            update((s) => selection.selectRange(s, ids, id));
          },
          extendFocus: (ids, delta) => {
            update((s) => selection.extendFocus(s, ids, delta));
          },
          clearSelection: () => {
            update(selection.clearSelection);
          },
          removeFromList: (removed, next, options) => {
            update((s) => selection.removeFromList(s, removed, next, options));
          },
          allowRemoteContent: (id) => {
            set((s) => ({
              remoteContentAllowed: new Set(s.remoteContentAllowed).add(id),
            }));
          },
          setColumnWidth: (index, width) => {
            set((s) => {
              const columnWidths: [number, number] = [...s.columnWidths];
              columnWidths[index] = clampWidth(index, width);
              return { columnWidths };
            });
          },
          setListOrder: (listOrder) => {
            set({ listOrder });
          },
          setTheme: (theme) => {
            saveTheme(storage, theme);
            set({ theme });
          },
          setReaderCursor: (readerCursor) => {
            set({ readerCursor });
          },
          updateSettings: (patch) => {
            set((s) => ({ settings: { ...s.settings, ...patch } }));
          },
          trustSender: (address) => {
            const lower = address.toLowerCase();
            set((s) => ({
              settings: {
                ...s.settings,
                trustedSenders: [
                  ...s.settings.trustedSenders.filter((a) => a !== lower),
                  lower,
                ].slice(-MAX_TRUSTED_SENDERS),
              },
            }));
          },
          untrustSender: (address) => {
            const lower = address.toLowerCase();
            set((s) => ({
              settings: {
                ...s.settings,
                trustedSenders: s.settings.trustedSenders.filter(
                  (a) => a !== lower,
                ),
              },
            }));
          },
          setFolderFilter: (folderFilter) => {
            set({ folderFilter });
          },
          toggleNode: (key) => {
            set((s) => {
              const toggledNodes = new Set(s.toggledNodes);
              if (!toggledNodes.delete(key)) toggledNodes.add(key);
              return { toggledNodes };
            });
          },
          setDrawerOpen: (drawerOpen) => {
            set({ drawerOpen });
          },
          setHelpOpen: (helpOpen) => {
            set({ helpOpen });
          },
          showToast: (toast) => {
            set((s) => ({
              toast: {
                ...toast,
                id: (s.toast?.id ?? 0) + 1,
                createdAt: Date.now(),
              },
            }));
          },
          dismissToast: (id) => {
            set((s) => (s.toast?.id === id ? { toast: null } : {}));
          },
          setDragging: (dragging) => {
            set({ dragging });
          },
          setPicker: (picker) => {
            set({ picker });
          },
          setConfirm: (confirm) => {
            set({ confirm });
          },
          setAddAccountOpen: (addAccountOpen) => {
            set({ addAccountOpen });
          },
          openComposer: ({ dirty = false, key, ...init }) => {
            const session: ComposerSession = {
              to: [],
              cc: [],
              bcc: [],
              subject: "",
              body: "",
              attachments: [],
              showCcBcc: false,
              window: "docked",
              focus: "to",
              ...init,
              key: key ?? ++sequence,
              revision: dirty ? 1 : 0,
              savedRevision: 0,
              saving: false,
            };
            set({ composer: session });
            return session;
          },
          updateComposer: (key, patch, edit) => {
            set((s) =>
              s.composer?.key === key
                ? {
                    composer: {
                      ...s.composer,
                      ...patch,
                      revision: s.composer.revision + (edit ? 1 : 0),
                    },
                  }
                : {},
            );
          },
          markComposerSaving: (key) => {
            set((s) =>
              s.composer?.key === key
                ? { composer: { ...s.composer, saving: true } }
                : {},
            );
          },
          markComposerSaved: (key, result) => {
            set((s) => {
              if (s.composer?.key !== key) return {};
              const { saveError, ...rest } = s.composer;
              return {
                composer:
                  "error" in result
                    ? { ...rest, saving: false, saveError: result.error }
                    : {
                        ...rest,
                        saving: false,
                        draftId: result.draftId,
                        savedRevision: Math.max(
                          rest.savedRevision,
                          result.revision,
                        ),
                      },
              };
            });
          },
          closeComposer: (key) => {
            set((s) => (s.composer?.key === key ? { composer: null } : {}));
          },
          queueSend: (key, delayMs) => {
            const { composer, pendingSends } = get();
            if (composer?.key !== key) return undefined;
            const now = Date.now();
            const pending: PendingSend = {
              id: ++sequence,
              session: composer,
              queuedAt: now,
              sendAt: now + delayMs,
            };
            set({ composer: null, pendingSends: [...pendingSends, pending] });
            return pending;
          },
          takePendingSend: (id) => {
            const pending = get().pendingSends.find((p) => p.id === id);
            if (pending)
              set((s) => ({
                pendingSends: s.pendingSends.filter((p) => p.id !== id),
              }));
            return pending;
          },
          markUnsubscribed: (id) => {
            set((s) => ({ unsubscribed: new Set(s.unsubscribed).add(id) }));
          },
          setLabelMenu: (labelMenu) => {
            set({ labelMenu });
          },
          setLabelDialog: (labelDialog) => {
            set({ labelDialog });
          },
          setManageLabels: (manageLabels) => {
            set({ manageLabels });
          },
        };
      },
      {
        name: UI_STATE_KEY,
        version: 1,
        storage: createJSONStorage(() => storage ?? noStorage),
        partialize: (state) => ({
          columnWidths: state.columnWidths,
          toggledNodes: [...state.toggledNodes],
          listOrder: state.listOrder,
          settings: state.settings,
        }),
        merge: (persisted, current) => {
          const { columnWidths, toggledNodes, listOrder, settings } =
            (persisted ?? {}) as PersistedUi;
          const widths =
            Array.isArray(columnWidths) &&
            columnWidths.length === 2 &&
            columnWidths.every((w) => typeof w === "number")
              ? ([
                  clampWidth(0, Number(columnWidths[0])),
                  clampWidth(1, Number(columnWidths[1])),
                ] as const)
              : current.columnWidths;
          const toggledKeys = Array.isArray(toggledNodes)
            ? toggledNodes.filter(
                (key): key is string => typeof key === "string",
              )
            : [];
          return {
            ...current,
            columnWidths: widths,
            toggledNodes: new Set(toggledKeys),
            listOrder: listOrder === "oldest" ? "oldest" : "newest",
            settings: parseSettings(settings),
          };
        },
      },
    ),
  );
}
