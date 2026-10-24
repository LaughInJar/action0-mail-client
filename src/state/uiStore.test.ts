// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asMessageId } from "../core/ids";
import { DEFAULT_SETTINGS } from "./settings";
import { MemoryStorage } from "../test/memoryStorage";
import { COLUMN_LIMITS, createUiStore, UI_STATE_KEY } from "./uiStore";

describe("uiStore persistence", () => {
  it("persists only column widths, tree expansion and list order, never mail-related state", () => {
    const storage = new MemoryStorage();
    const store = createUiStore(storage);
    const {
      setColumnWidth,
      toggleNode,
      enterList,
      toggle,
      allowRemoteContent,
      setListOrder,
      setFolderFilter,
    } = store.getState();
    setColumnWidth(0, 300);
    setListOrder("oldest");
    setFolderFilter("secret-filter");
    toggleNode("account:x");
    enterList("acct/inbox", asMessageId("secret-message-id"));
    toggle(asMessageId("selected-id"));
    allowRemoteContent(asMessageId("allowed-id"));

    const persisted = JSON.parse(storage.getItem(UI_STATE_KEY) ?? "{}") as {
      state: object;
    };
    expect(persisted.state).toEqual({
      columnWidths: [300, COLUMN_LIMITS[1].initial],
      toggledNodes: ["account:x"],
      listOrder: "oldest",
      settings: DEFAULT_SETTINGS,
      // Ids and times of dismissed or snoozed reminders, no content.
      reminderMarks: {},
    });
    expect(storage.dump()).not.toMatch(
      /secret-message-id|selected-id|allowed-id|secret-filter/,
    );
  });

  it("restores valid values and clamps or ignores bad ones", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        state: {
          columnWidths: [5, 9999],
          toggledNodes: ["a", 3],
          listOrder: "sideways",
          settings: { density: "compact", undoSendSeconds: 7, markRead: 1 },
        },
        version: 1,
      }),
    );
    const state = createUiStore(storage).getState();
    expect(state.columnWidths).toEqual([
      COLUMN_LIMITS[0].min,
      COLUMN_LIMITS[1].max,
    ]);
    expect([...state.toggledNodes]).toEqual(["a"]);
    expect(state.listOrder).toBe("newest");
    expect(state.settings).toEqual({
      ...DEFAULT_SETTINGS,
      density: "compact",
    });

    storage.setItem(UI_STATE_KEY, "not json");
    expect(createUiStore(storage).getState().columnWidths).toEqual([
      COLUMN_LIMITS[0].initial,
      COLUMN_LIMITS[1].initial,
    ]);
  });

  it("keeps trusted senders in lower case, once each", () => {
    const store = createUiStore(new MemoryStorage());
    store.getState().trustSender("Anna@Example.org");
    store.getState().trustSender("anna@example.org");
    store.getState().trustSender("bob@example.org");
    expect(store.getState().settings.trustedSenders).toEqual([
      "anna@example.org",
      "bob@example.org",
    ]);
    store.getState().untrustSender("ANNA@example.org");
    expect(store.getState().settings.trustedSenders).toEqual([
      "bob@example.org",
    ]);
  });

  it("resets focus and selection when entering another list", () => {
    const store = createUiStore(undefined);
    store.getState().toggle(asMessageId("a"));
    store.getState().enterList("acct/sent", null);
    expect(store.getState()).toMatchObject({
      listKey: "acct/sent",
      focusedId: null,
      anchorId: null,
    });
    expect(store.getState().selectedIds.size).toBe(0);
  });
});
