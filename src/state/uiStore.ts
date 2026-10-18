import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AccountId, MessageId } from "../core/ids";
import type { MailIntent } from "../core/intents";
import type { MessageSummary } from "../core/model";
import * as selection from "./selection";

/** A short notification at the bottom of the screen, optionally undoable. */
export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "error";
  /** Intents that revert the action the toast reports. */
  readonly undo?: {
    readonly accountId: AccountId;
    readonly intents: readonly MailIntent[];
    /** The messages as the action left them, for messages that left every cached list. */
    readonly known: readonly MessageSummary[];
  };
}

/** UI state that isn't server data and isn't in the URL. */
export interface UiState extends selection.SelectionState {
  /** `${accountId}/${mailboxId}` of the list that focus and selection belong to. */
  readonly listKey: string | null;
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
  readonly allowRemoteContent: (id: MessageId) => void;
  readonly setColumnWidth: (index: 0 | 1, width: number) => void;
  readonly toggleNode: (key: string) => void;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly setHelpOpen: (open: boolean) => void;
  /** Shows a toast, replacing the current one. */
  readonly showToast: (toast: Omit<Toast, "id">) => void;
  /** Hides the toast with this id (if it is still the current one). */
  readonly dismissToast: (id: number) => void;
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
}

/**
 * Creates the UI store. Only column widths and tree expansion are
 * persisted (to `storage`, i.e. localStorage); nothing that contains mail.
 */
export function createUiStore(storage: Storage | undefined): UiStore {
  return createStore<UiState & UiActions>()(
    persist(
      (set) => {
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
          drawerOpen: false,
          helpOpen: false,
          toast: null,

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
            set((s) => ({ toast: { ...toast, id: (s.toast?.id ?? 0) + 1 } }));
          },
          dismissToast: (id) => {
            set((s) => (s.toast?.id === id ? { toast: null } : {}));
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
        }),
        merge: (persisted, current) => {
          const { columnWidths, toggledNodes } = (persisted ??
            {}) as PersistedUi;
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
          };
        },
      },
    ),
  );
}
