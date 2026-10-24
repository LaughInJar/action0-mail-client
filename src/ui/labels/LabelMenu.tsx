import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { useAccountHandle } from "../../accounts/context";
import { findMailbox } from "../../data/hooks";
import { useUi } from "../../state/context";
import type { LabelMenuState } from "../../state/uiStore";
import { useFocusTrap } from "../common/useFocusTrap";
import { useLabelActions } from "./useLabelActions";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";
import { mailboxTexts } from "./mailboxTexts";

/** Shows the label menu while one is open. */
export function LabelMenuHost() {
  const menu = useUi((state) => state.labelMenu);
  if (!menu) return null;
  return <LabelMenu key={`${menu.accountId}/${menu.mailboxId}`} menu={menu} />;
}

/** Space kept between the menu and the edges of the screen. */
const MARGIN = 8;

/**
 * What can be done with one of the user's labels. An ARIA menu: ↑/↓, Home
 * and End move, Enter or Space chooses, Esc or a click elsewhere closes.
 */
function LabelMenu({ menu }: { menu: LabelMenuState }) {
  const setLabelMenu = useUi((state) => state.setLabelMenu);
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const { data: mailboxes } = useMailboxList(menu.accountId);
  const mailbox = findMailbox(mailboxes, menu.mailboxId);
  const capabilities = useAccountHandle(menu.accountId)?.provider.capabilities;
  const rules = mailbox
    ? capabilities?.mailboxEditing[mailbox.kind]
    : undefined;
  const colors = rules?.colors ?? [];
  const labels = useLabelActions();
  const l = mailboxTexts(useT(), capabilities, mailbox?.kind);
  const menuRef = useRef<HTMLDivElement>(null);
  // The click that ends a long-press lands on whatever opened under the
  // finger: only presses that started on the backdrop or the menu count.
  const pressed = useRef<"backdrop" | "menu" | null>(null);
  const close = () => {
    setLabelMenu(null);
  };
  useFocusTrap(menuRef, mailbox !== undefined, close);

  // Keep the menu on screen (it opens where the pointer or the label is).
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(
      MARGIN,
      Math.min(menu.x, window.innerWidth - width - MARGIN),
    );
    const top =
      menu.y + height + MARGIN <= window.innerHeight
        ? menu.y
        : Math.max(MARGIN, menu.flipY - height);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [menu.x, menu.y, menu.flipY]);

  if (!mailbox) return null;
  const { accountId } = menu;
  const edit = (focus: "name" | "parent" | "color") => () => {
    setLabelDialog({ mode: "edit", accountId, mailboxId: mailbox.id, focus });
  };
  const items: readonly {
    readonly label: string;
    readonly run: () => void;
    readonly danger?: boolean;
  }[] = [
    ...(rules?.rename === false
      ? []
      : [{ label: l.rename, run: edit("name") }]),
    ...(colors.length > 0 ? [{ label: l.colourMenu, run: edit("color") }] : []),
    ...(rules?.nest === false
      ? []
      : [
          { label: l.moveUnder, run: edit("parent") },
          {
            label: l.addSublabel,
            run: () => {
              setLabelDialog({
                mode: "create",
                accountId,
                parentId: mailbox.id,
              });
            },
          },
        ]),
    ...(rules?.hide
      ? [
          {
            label: mailbox.hidden ? l.showInFolderList : l.hideFromFolderList,
            run: () => {
              labels.toggleHidden(accountId, mailbox);
            },
          },
        ]
      : []),
    {
      label: l.deleteMenu,
      danger: true,
      run: () => {
        labels.requestDelete(accountId, mailbox);
      },
    },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const index = entries.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = entries[(index + 1) % entries.length];
    else if (event.key === "ArrowUp")
      next = entries.at((index - 1) % entries.length);
    else if (event.key === "Home") next = entries[0];
    else if (event.key === "End") next = entries.at(-1);
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        tabIndex={-1}
        aria-label={l.closeMenu}
        onPointerDown={() => {
          pressed.current = "backdrop";
        }}
        onClick={() => {
          if (pressed.current === "backdrop") close();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          close();
        }}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={l.menuOf(mailbox.name)}
        tabIndex={-1}
        data-own-keys=""
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          pressed.current = "menu";
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        style={{ left: menu.x, top: menu.y }}
        className="absolute min-w-48 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={(event) => {
              // detail 0: chosen with the keyboard.
              if (event.detail !== 0 && pressed.current !== "menu") return;
              close();
              item.run();
            }}
            className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 pointer-coarse:min-h-11 ${
              item.danger ? "text-red-700 dark:text-red-400" : ""
            }`}
          >
            {item.label}
          </button>
        ))}
        {rules?.rename === false && (
          <p className="max-w-56 px-3 pt-1.5 pb-1 text-xs text-zinc-500">
            {l.cantRename}
          </p>
        )}
      </div>
    </div>
  );
}
