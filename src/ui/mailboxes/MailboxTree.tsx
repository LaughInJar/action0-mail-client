import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useAccounts, useAuthStatus } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import {
  asAccountId,
  asMailboxId,
  messageRef,
  type AccountId,
} from "../../core/ids";
import type { Mailbox, MailboxRole } from "../../core/model";
import { isOwnMailbox } from "../../data/mailboxActions";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import { sameList } from "../../state/router";
import { findFolded } from "../../lib/text";
import { useMailActions } from "../actions/useMailActions";
import { useAccountColors } from "../accounts/accountColors";
import { useCurrentList } from "../messages/useCurrentList";
import {
  ALL_INBOXES_FROM,
  useInboxUnread,
  useOpenAllInboxes,
} from "./allInboxes";
import { Icon, type IconName } from "../common/Icon";
import { useLongPress } from "../messages/useLongPress";
import {
  badgeCount,
  buildMailboxTree,
  expandedByDefault,
  filterMailboxTree,
  type MailboxNode,
} from "./buildTree";
import { FOLDER_FILTER_ID } from "./FolderFilter";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";

/**
 * The tree item currently under a drag, and whether the drop would only
 * add a label, or isn't possible (a mailbox of another account).
 */
interface DropHighlight {
  readonly key: string;
  readonly copy: boolean;
  readonly otherAccount?: boolean;
  /** An Outlook category: dropping adds it (the mail stays in its folder). */
  readonly category?: boolean;
}

const DropContext = createContext<DropHighlight | null>(null);

/** The folder filter's text (blank when not filtering). */
const FilterContext = createContext("");

const ROLE_ICONS: Readonly<Record<MailboxRole, IconName>> = {
  inbox: "inbox",
  flagged: "star",
  important: "bookmark",
  sent: "send",
  drafts: "file",
  all: "archive",
  archive: "archive",
  junk: "alert",
  trash: "trash",
};

function mailboxIcon(mailbox: Mailbox): IconName {
  if (mailbox.role) return ROLE_ICONS[mailbox.role];
  if (mailbox.kind === "label") return "tag";
  return "folder";
}

/** Props of {@link MailboxTree}. */
export interface MailboxTreeProps {
  /** Called after a mailbox was chosen (e.g. to close the drawer). */
  readonly onNavigate?: () => void;
}

/**
 * The accounts and their mailboxes as one ARIA tree (flat DOM with
 * `aria-level`). Arrow keys move between visible items, ←/→ collapse and
 * expand, Enter or Space opens a mailbox. Clicks are delegated to the tree.
 * While the folder filter has text, only matches and their parents show,
 * all expanded. The user's own labels have a menu (rename, colour, ...):
 * the ⋯ button on the selected one, right-click, long-press, or Shift+F10
 * and the Menu key.
 */
export function MailboxTree({ onNavigate }: MailboxTreeProps) {
  const accounts = useAccounts();
  const route = useRoute();
  const router = useRouter();
  const treeRef = useRef<HTMLDivElement>(null);
  const toggleNode = useUi((state) => state.toggleNode);
  const store = useUiStore();
  const actions = useMailActions();
  const { sources } = useCurrentList();
  const openAllInboxes = useOpenAllInboxes();
  const [drop, setDrop] = useState<DropHighlight | null>(null);
  const filter = useUi((state) => state.folderFilter).trim();
  const a = useT().accounts;

  /**
   * Opens the label menu of `item`: at a pointer position, below an anchor
   * element, or below the item itself. False if the item has no menu.
   */
  const openMenu = (
    item: HTMLElement,
    at?: { x: number; y: number } | Element,
  ) => {
    const { accountId, mailboxId, editable } = item.dataset;
    if (editable !== "true" || !accountId || !mailboxId) return false;
    let position;
    if (at && "x" in at && !(at instanceof Element))
      position = { x: at.x, y: at.y, flipY: at.y };
    else {
      const rect = (at ?? item).getBoundingClientRect();
      position = {
        x: at ? rect.left : rect.left + 24,
        y: rect.bottom,
        flipY: rect.top,
      };
    }
    store.getState().setLabelMenu({
      accountId: asAccountId(accountId),
      mailboxId: asMailboxId(mailboxId),
      ...position,
    });
    return true;
  };
  // A long press opens the menu; without one (system mailboxes) it's a tap.
  const pressOpenedMenu = useRef(false);
  const longPress = useLongPress((target) => {
    const item = (target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    pressOpenedMenu.current = item ? openMenu(item) : false;
  });

  /** The mailbox under a drag, if the dragged messages may go there. */
  const dropTargetOf = (target: EventTarget) => {
    const item = (target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    const dragging = store.getState().dragging;
    if (!item || !dragging) return undefined;
    const {
      key = "",
      accountId,
      mailboxId,
      assignable,
      role,
      kind,
    } = item.dataset;
    if (accountId === undefined || mailboxId === undefined) return undefined;
    if (assignable !== "true") return undefined;
    // The mailbox they're listed in isn't a target.
    const current = router.getRoute();
    const listed = current?.unified
      ? sources.get(asAccountId(accountId))?.scope?.id
      : current?.accountId === accountId
        ? current.mailboxId
        : undefined;
    if (listed === mailboxId) return undefined;
    const folders = accounts
      .find((handle) => handle.account.id === accountId)
      ?.provider.capabilities.mailboxKinds.includes("folder");
    return {
      key,
      role,
      mailboxId: asMailboxId(mailboxId),
      keys: dragging.keys,
      category: folders === true && kind === "label",
      // Mail can't move between accounts.
      otherAccount: dragging.keys.some(
        (dragged) => messageRef(dragged).accountId !== accountId,
      ),
    };
  };

  // Ctrl (Linux/Windows) or Alt/Option (macOS) while dropping: only add the
  // label. Spam and Trash aren't labels, so there it always moves.
  const wantsCopy = (
    event: DragEvent,
    target: { readonly role: string | undefined; readonly category: boolean },
  ) =>
    target.category ||
    ((event.ctrlKey || event.altKey) &&
      actions.canLabel &&
      target.role !== "trash" &&
      target.role !== "junk");

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const target = dropTargetOf(event.target);
    if (!target) {
      setDrop(null);
      return;
    }
    if (target.otherAccount) {
      event.dataTransfer.dropEffect = "none";
      setDrop((current) =>
        current?.key === target.key && current.otherAccount === true
          ? current
          : { key: target.key, copy: false, otherAccount: true },
      );
      return;
    }
    event.preventDefault();
    const copy = wantsCopy(event, target);
    event.dataTransfer.dropEffect = copy ? "copy" : "move";
    setDrop((current) =>
      current?.key === target.key && current.copy === copy
        ? current
        : { key: target.key, copy, category: target.category },
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const target = dropTargetOf(event.target);
    setDrop(null);
    if (!target || target.otherAccount) return;
    event.preventDefault();
    store.getState().setDragging(null);
    if (wantsCopy(event, target))
      actions.setLabels([target.mailboxId], [], target.keys);
    else actions.moveTo(target.mailboxId, target.keys);
  };
  const routeAccountKnown = accounts.some(
    (handle) => handle.account.id === route?.accountId,
  );

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (longPress.consumeClick() && pressOpenedMenu.current) return;
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    if (!item) return;
    const menuButton = target.closest("[data-label-menu]");
    if (menuButton) {
      openMenu(item, menuButton);
      return;
    }
    if (item.dataset.unified === "true") {
      if (openAllInboxes()) {
        store.getState().setFolderFilter("");
        onNavigate?.();
      }
      return;
    }
    const {
      key = "",
      accountId,
      mailboxId,
      selectable,
      hasChildren,
    } = item.dataset;
    const onChevron = target.closest("[data-toggle]") !== null;
    if (hasChildren === "true" && (onChevron || selectable !== "true")) {
      // While filtering, everything that's shown is expanded.
      if (!filter) toggleNode(key);
      return;
    }
    if (
      selectable !== "true" ||
      accountId === undefined ||
      mailboxId === undefined
    )
      return;
    const destination = {
      accountId: asAccountId(accountId),
      mailboxId: asMailboxId(mailboxId),
    };
    if (!sameList(router.getRoute(), destination)) router.navigate(destination);
    store.getState().setFolderFilter("");
    onNavigate?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    if (!current) return;
    const index = items.indexOf(current);
    const expanded = current.getAttribute("aria-expanded");
    const focus = (item: HTMLElement | undefined) => item?.focus();

    switch (event.key) {
      case "ArrowDown":
        focus(items[index + 1]);
        break;
      case "ArrowUp":
        if (index === 0) document.getElementById(FOLDER_FILTER_ID)?.focus();
        else focus(items[index - 1]);
        break;
      case "Home":
        focus(items[0]);
        break;
      case "End":
        focus(items.at(-1));
        break;
      case "ArrowRight":
        if (expanded === "false" && !filter)
          toggleNode(current.dataset.key ?? "");
        else if (expanded === "true") focus(items[index + 1]);
        break;
      case "ArrowLeft":
        if (expanded === "true" && !filter)
          toggleNode(current.dataset.key ?? "");
        else
          focus(
            items.find(
              (item) => item.dataset.key === current.dataset.parentKey,
            ),
          );
        break;
      case "Enter":
      case " ":
        current.click();
        break;
      case "ContextMenu":
        if (!openMenu(current)) return;
        break;
      case "F10":
        if (!event.shiftKey || !openMenu(current)) return;
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    // Keyboard-made events (Menu key) have no pointer position.
    const fromPointer = event.clientX !== 0 || event.clientY !== 0;
    if (
      item &&
      openMenu(
        item,
        fromPointer ? { x: event.clientX, y: event.clientY } : undefined,
      )
    )
      event.preventDefault();
    else longPress.onContextMenu(event);
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={a.tree}
      tabIndex={-1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDrop(null);
      }}
      onDrop={onDrop}
      className="space-y-px px-2 py-2 focus:outline-none"
    >
      <FilterContext value={filter}>
        <DropContext value={drop}>
          {accounts.length >= ALL_INBOXES_FROM && (
            <AllInboxesItem selected={route?.unified === true} />
          )}
          {accounts.map((handle, index) => (
            <AccountBranch
              key={handle.account.id}
              handle={handle}
              isTabStop={!routeAccountKnown && index === 0}
            />
          ))}
        </DropContext>
      </FilterContext>
    </div>
  );
}

interface AccountBranchProps {
  readonly handle: AccountHandle;
  readonly isTabStop: boolean;
}

function AccountBranch({ handle, isTabStop }: AccountBranchProps) {
  const { account, auth } = handle;
  const status = useAuthStatus(auth);
  const { data: mailboxes, isPending, isError } = useMailboxList(account.id);
  const filter = useContext(FilterContext);
  const nodes = useMemo(() => {
    const tree = buildMailboxTree(mailboxes ?? []);
    return filter ? filterMailboxTree(tree, filter) : tree;
  }, [mailboxes, filter]);
  const toggledNodes = useUi((state) => state.toggledNodes);
  const key = `account:${account.id}`;
  const expanded = filter !== "" || !toggledNodes.has(key);
  const a = useT().accounts;
  // Only needed to tell accounts apart in All inboxes.
  const accounts = useAccounts();
  const colors = useAccountColors();
  const color =
    accounts.length >= ALL_INBOXES_FROM ? colors.get(account.id) : undefined;

  let body;
  if (!expanded) body = null;
  else if (!mailboxes && status !== "signed-in")
    body = <TreeNote>{a.reconnectToLoad}</TreeNote>;
  else if (isPending) body = <TreeNote>{a.loadingFolders}</TreeNote>;
  else if (isError && !mailboxes)
    body = <TreeNote>{a.couldntLoadFolders}</TreeNote>;
  else if (filter && nodes.length === 0)
    body = <TreeNote>{a.noMatchingFolders}</TreeNote>;
  else
    body = nodes.map((node) => (
      <MailboxBranch
        key={node.mailbox.id}
        accountId={account.id}
        node={node}
        depth={2}
        parentKey={key}
        manageable={handle.provider.capabilities.manageMailboxes}
      />
    ));

  return (
    <>
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={false}
        tabIndex={isTabStop ? 0 : -1}
        data-key={key}
        data-has-children="true"
        data-selectable="false"
        className={`${rowClass(false)} pl-2`}
      >
        <Chevron expanded={expanded} />
        <span className="relative shrink-0">
          <Icon name="user" className="size-4 text-zinc-500" />
          {color && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-zinc-50 dark:ring-zinc-950"
              style={{ backgroundColor: color }}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">
          {account.email}
        </span>
        {status === "expired" && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {a.signedOut}
          </span>
        )}
      </div>
      {body}
    </>
  );
}

/** "All inboxes": every account's Inbox in one list. */
function AllInboxesItem({ selected }: { readonly selected: boolean }) {
  const filter = useContext(FilterContext);
  const unread = useInboxUnread();
  const a = useT().accounts;
  const name = a.allInboxes;
  const match = filter === "" || findFolded(name, filter) !== undefined;
  if (!match) return null;
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-key="all-inboxes"
      data-unified="true"
      data-selectable="true"
      data-has-children="false"
      data-match={filter === "" ? undefined : true}
      className={`${rowClass(selected)} pl-2`}
    >
      <span className="size-4 shrink-0" />
      <Icon name="inbox" className="size-4 shrink-0" />
      <span
        className={`min-w-0 flex-1 truncate ${unread > 0 ? "font-semibold" : ""}`}
      >
        <Highlighted text={name} query={filter} />
      </span>
      {unread > 0 && (
        <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          <span className="sr-only">, </span>
          {unread}
          <span className="sr-only">{a.unread}</span>
        </span>
      )}
    </div>
  );
}

function TreeNote({ children }: { children: string }) {
  return <p className="py-1 pl-10 text-xs text-zinc-500">{children}</p>;
}

interface MailboxBranchProps {
  readonly accountId: AccountId;
  readonly node: MailboxNode;
  readonly depth: number;
  readonly parentKey: string;
  /** The account's own mailboxes can be changed (they get a menu). */
  readonly manageable: boolean;
}

function MailboxBranch({
  accountId,
  node,
  depth,
  parentKey,
  manageable,
}: MailboxBranchProps) {
  const { mailbox, children } = node;
  const route = useRoute();
  const toggledNodes = useUi((state) => state.toggledNodes);
  const filter = useContext(FilterContext);
  const key = `${accountId}/${mailbox.id}`;
  const hasChildren = children.length > 0;
  const expanded =
    hasChildren &&
    (filter !== "" || expandedByDefault(mailbox) !== toggledNodes.has(key));
  const selected =
    route?.unified !== true &&
    route?.accountId === accountId &&
    route.mailboxId === mailbox.id;
  const badge = badgeCount(mailbox);
  const drop = useContext(DropContext);
  const dropHere = drop?.key === key;
  const editable = manageable && isOwnMailbox(mailbox);
  const a = useT().accounts;

  return (
    <>
      <div
        role="treeitem"
        aria-level={depth}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-key={key}
        data-parent-key={parentKey}
        data-account-id={accountId}
        data-mailbox-id={mailbox.id}
        data-selectable={String(mailbox.selectable)}
        data-has-children={String(hasChildren)}
        data-assignable={String(mailbox.assignable)}
        data-role={mailbox.role}
        data-kind={mailbox.kind}
        data-match={node.match}
        data-editable={editable || undefined}
        aria-haspopup={editable ? "menu" : undefined}
        aria-keyshortcuts={editable ? "Shift+F10" : undefined}
        className={`${rowClass(selected)} ${dropHere ? (drop.otherAccount ? "ring-2 ring-zinc-400" : "bg-blue-50 ring-2 ring-blue-500 dark:bg-blue-500/20") : ""}`}
        style={{ paddingLeft: `${(depth - 1) * 0.875 + 0.5}rem` }}
      >
        {hasChildren ? (
          <Chevron expanded={expanded} toggle />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <Icon
          name={mailboxIcon(mailbox)}
          className="size-4 shrink-0"
          style={
            mailbox.color ? { color: mailbox.color.background } : undefined
          }
        />
        <span
          className={`min-w-0 flex-1 truncate ${badge !== undefined && mailbox.role !== "drafts" ? "font-semibold" : ""} ${node.match === false ? "text-zinc-400 dark:text-zinc-500" : ""}`}
        >
          <Highlighted text={mailbox.name} query={filter} />
        </span>
        {dropHere && (
          <span
            className={`shrink-0 rounded px-1.5 py-px text-[0.6875rem] font-semibold text-white ${drop.otherAccount ? "bg-zinc-500" : "bg-blue-600"}`}
          >
            {drop.otherAccount
              ? a.otherAccount
              : drop.category
                ? a.addCategoryHere
                : drop.copy
                  ? a.addLabelHere
                  : a.moveHere}
          </span>
        )}
        {badge !== undefined && (
          <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
            <span className="sr-only">, </span>
            {badge}
            <span className="sr-only">
              {mailbox.role === "drafts" ? a.drafts(badge) : a.unread}
            </span>
          </span>
        )}
        {editable && selected && (
          // Mouse and touch only (keyboards have Shift+F10), so it stays
          // out of the tab order and out of the item's accessible name.
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-label-menu=""
            title={a.actionsFor(mailbox.name)}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            className="-my-1 grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-300/60 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 pointer-coarse:size-11"
          >
            <Icon name="more" className="size-4" />
          </button>
        )}
      </div>
      {expanded &&
        children.map((child) => (
          <MailboxBranch
            key={child.mailbox.id}
            accountId={accountId}
            node={child}
            depth={depth + 1}
            parentKey={key}
            manageable={manageable}
          />
        ))}
    </>
  );
}

/** `text` with the part matching `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const range = findFolded(text, query);
  if (!range) return text;
  const [start, end] = range;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-yellow-200 text-inherit dark:bg-yellow-500/40">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

function Chevron({
  expanded,
  toggle = false,
}: {
  expanded: boolean;
  toggle?: boolean;
}) {
  return (
    <span
      data-toggle={toggle ? "" : undefined}
      className="grid size-4 shrink-0 place-items-center text-zinc-400 pointer-coarse:size-6"
    >
      <Icon
        name={expanded ? "chevron-down" : "chevron-right"}
        className="size-3.5"
      />
    </span>
  );
}

function rowClass(selected: boolean): string {
  return [
    "flex cursor-default items-center gap-2 rounded-md py-1 pr-2 text-sm select-none",
    "pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
    selected
      ? "bg-blue-100 text-blue-900 dark:bg-blue-500/20 dark:text-blue-100"
      : "text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800",
  ].join(" ");
}
