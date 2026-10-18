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
import { asAccountId, asMailboxId, type AccountId } from "../../core/ids";
import type { Mailbox, MailboxRole } from "../../core/model";
import { useMailboxes } from "../../data/hooks";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import { sameList } from "../../state/router";
import { findFolded } from "../../lib/text";
import { useMailActions } from "../actions/useMailActions";
import { Icon, type IconName } from "../common/Icon";
import {
  badgeCount,
  buildMailboxTree,
  expandedByDefault,
  filterMailboxTree,
  type MailboxNode,
} from "./buildTree";
import { FOLDER_FILTER_ID } from "./FolderFilter";

/** The tree item currently under a drag, and whether the drop would only add a label. */
interface DropHighlight {
  readonly key: string;
  readonly copy: boolean;
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
 * all expanded.
 */
export function MailboxTree({ onNavigate }: MailboxTreeProps) {
  const accounts = useAccounts();
  const route = useRoute();
  const router = useRouter();
  const treeRef = useRef<HTMLDivElement>(null);
  const toggleNode = useUi((state) => state.toggleNode);
  const store = useUiStore();
  const actions = useMailActions();
  const [drop, setDrop] = useState<DropHighlight | null>(null);
  const filter = useUi((state) => state.folderFilter).trim();

  /** The mailbox under a drag, if the dragged messages may go there. */
  const dropTargetOf = (target: EventTarget) => {
    const item = (target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    const dragging = store.getState().dragging;
    if (!item || !dragging) return undefined;
    const { key = "", accountId, mailboxId, assignable, role } = item.dataset;
    if (accountId !== dragging.accountId || mailboxId === undefined)
      return undefined;
    if (assignable !== "true") return undefined;
    const current = router.getRoute();
    if (current?.accountId === accountId && current.mailboxId === mailboxId)
      return undefined;
    return {
      key,
      role,
      mailboxId: asMailboxId(mailboxId),
      ids: dragging.ids,
    };
  };

  // Ctrl (Linux/Windows) or Alt/Option (macOS) while dropping: only add the
  // label. Spam and Trash aren't labels, so there it always moves.
  const wantsCopy = (event: DragEvent, role: string | undefined) =>
    (event.ctrlKey || event.altKey) &&
    actions.canLabel &&
    role !== "trash" &&
    role !== "junk";

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const target = dropTargetOf(event.target);
    if (!target) {
      setDrop(null);
      return;
    }
    event.preventDefault();
    const copy = wantsCopy(event, target.role);
    event.dataTransfer.dropEffect = copy ? "copy" : "move";
    setDrop((current) =>
      current?.key === target.key && current.copy === copy
        ? current
        : { key: target.key, copy },
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const target = dropTargetOf(event.target);
    setDrop(null);
    if (!target) return;
    event.preventDefault();
    store.getState().setDragging(null);
    if (wantsCopy(event, target.role))
      actions.setLabels([target.mailboxId], [], target.ids);
    else actions.moveTo(target.mailboxId, target.ids);
  };
  const routeAccountKnown = accounts.some(
    (handle) => handle.account.id === route?.accountId,
  );

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    if (!item) return;
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
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Accounts and mailboxes"
      tabIndex={-1}
      onClick={onClick}
      onKeyDown={onKeyDown}
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
  const { data: mailboxes, isPending, isError } = useMailboxes(account.id);
  const filter = useContext(FilterContext);
  const nodes = useMemo(() => {
    const tree = buildMailboxTree(mailboxes ?? []);
    return filter ? filterMailboxTree(tree, filter) : tree;
  }, [mailboxes, filter]);
  const toggledNodes = useUi((state) => state.toggledNodes);
  const key = `account:${account.id}`;
  const expanded = filter !== "" || !toggledNodes.has(key);

  let body;
  if (!expanded) body = null;
  else if (!mailboxes && status !== "signed-in")
    body = <TreeNote>Reconnect to load folders.</TreeNote>;
  else if (isPending) body = <TreeNote>Loading folders…</TreeNote>;
  else if (isError && !mailboxes)
    body = <TreeNote>Couldn’t load folders.</TreeNote>;
  else if (filter && nodes.length === 0)
    body = <TreeNote>No matching folders.</TreeNote>;
  else
    body = nodes.map((node) => (
      <MailboxBranch
        key={node.mailbox.id}
        accountId={account.id}
        node={node}
        depth={2}
        parentKey={key}
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
        <Icon name="user" className="size-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">
          {account.email}
        </span>
        {status === "expired" && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            signed out
          </span>
        )}
      </div>
      {body}
    </>
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
}

function MailboxBranch({
  accountId,
  node,
  depth,
  parentKey,
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
    route?.accountId === accountId && route.mailboxId === mailbox.id;
  const badge = badgeCount(mailbox);
  const drop = useContext(DropContext);
  const dropHere = drop?.key === key;

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
        data-match={node.match}
        className={`${rowClass(selected)} ${dropHere ? "bg-blue-50 ring-2 ring-blue-500 dark:bg-blue-500/20" : ""}`}
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
          <span className="shrink-0 rounded bg-blue-600 px-1.5 py-px text-[0.6875rem] font-semibold text-white">
            {drop.copy ? "Add label" : "Move here"}
          </span>
        )}
        {badge !== undefined && (
          <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
            <span className="sr-only">, </span>
            {badge}
            <span className="sr-only">
              {mailbox.role === "drafts"
                ? badge === 1
                  ? " draft"
                  : " drafts"
                : " unread"}
            </span>
          </span>
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
