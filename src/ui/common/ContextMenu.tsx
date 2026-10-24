import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { MenuPosition } from "../../state/uiStore";
import { useBreakpoint } from "../layout/useBreakpoint";
import { Icon, type IconName } from "./Icon";
import { Sheet } from "./Sheet";
import { useFocusTrap } from "./useFocusTrap";

/** One entry of a {@link ContextMenu}. */
export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly run: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Filled icon (a starred message). */
  readonly pressed?: boolean;
  /** One of a set of choices, with a check when it's the current one. */
  readonly checked?: boolean;
  /** Starts a new group: a line above it. */
  readonly divider?: boolean;
}

/** Props of {@link ContextMenu}. */
export interface ContextMenuProps {
  /** Accessible name of the menu ("Label Work", "3 messages"). */
  readonly label: string;
  /** Shown as the bottom sheet's heading on phones. */
  readonly title: string;
  readonly at: MenuPosition;
  readonly entries: readonly MenuEntry[];
  /** A short text below the entries (e.g. why something is missing). */
  readonly note?: ReactNode;
  readonly onClose: () => void;
}

/** Space kept between the menu and the edges of the screen. */
const MARGIN = 8;

/**
 * A context menu: a popup at the pointer (kept on screen), or a bottom
 * sheet with large rows on phones. An ARIA menu: ↑/↓, Home and End move,
 * Enter or Space chooses, Esc or a click elsewhere closes.
 */
export function ContextMenu(props: ContextMenuProps) {
  return useBreakpoint() === "narrow" ? (
    <SheetMenu {...props} />
  ) : (
    <PopupMenu {...props} />
  );
}

/** ↑/↓, Home and End between the entries of `menu`. */
function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  menu: HTMLElement | null,
) {
  const entries = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ??
      [],
  );
  const index = entries.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = entries[(index + 1) % entries.length];
  else if (event.key === "ArrowUp")
    next = entries.at((index - 1) % entries.length);
  else if (event.key === "Home") next = entries[0];
  else if (event.key === "End") next = entries.at(-1);
  else return false;
  event.preventDefault();
  next?.focus();
  return true;
}

/** Whether any entry has an icon: the others keep its space, so labels line up. */
function hasIcons(entries: readonly MenuEntry[]): boolean {
  return entries.some(
    (entry) => entry.icon !== undefined || entry.checked !== undefined,
  );
}

/**
 * Whether a pointer went down since the menu opened. The click that ends
 * a long press lands on whatever opened under the finger: it doesn't
 * count, neither as a choice nor as a click outside.
 */
function useFreshPress() {
  const fresh = useRef(false);
  useEffect(() => {
    const down = () => {
      fresh.current = true;
    };
    window.addEventListener("pointerdown", down, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", down, { capture: true });
    };
  }, []);
  return fresh;
}

function PopupMenu({ label, at, entries, note, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const icons = hasIcons(entries);
  const fresh = useFreshPress();
  useFocusTrap(menuRef, true, onClose);

  // Keep the menu on screen (it opens where the pointer or the item is).
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(
      MARGIN,
      Math.min(at.x, window.innerWidth - width - MARGIN),
    );
    const top =
      at.y + height + MARGIN <= window.innerHeight
        ? at.y
        : Math.max(MARGIN, at.flipY - height);
    element.style.left = `${String(left)}px`;
    element.style.top = `${String(top)}px`;
  }, [at.x, at.y, at.flipY]);

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          if (fresh.current) onClose();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        data-own-keys=""
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            onClose();
            return;
          }
          moveFocus(event, menuRef.current);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        style={{ left: at.x, top: at.y }}
        className="absolute max-h-[calc(100dvh-1rem)] min-w-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        {entries.map((entry, index) => (
          <Entry
            key={entry.id}
            entry={entry}
            icons={icons}
            first={index === entries.findIndex((item) => !item.disabled)}
            onChoose={(event) => {
              // detail 0: chosen with the keyboard.
              if (event.detail !== 0 && !fresh.current) return;
              onClose();
              entry.run();
            }}
          />
        ))}
        {note && (
          <p className="max-w-60 px-3 pt-1.5 pb-1 text-xs text-zinc-500">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

function SheetMenu({ label, title, entries, note, onClose }: ContextMenuProps) {
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const icons = hasIcons(entries);
  const fresh = useFreshPress();
  return (
    <Sheet
      labelledBy={titleId}
      onEscape={onClose}
      onBackdrop={() => {
        if (fresh.current) onClose();
      }}
      focusContainer
    >
      <h2
        id={titleId}
        className="truncate border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800"
      >
        {title}
      </h2>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        data-own-keys=""
        onKeyDown={(event) => {
          moveFocus(event, menuRef.current);
        }}
        className="min-h-0 overflow-y-auto overscroll-contain py-1"
      >
        {entries.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            icons={icons}
            first={false}
            onChoose={(event) => {
              if (event.detail !== 0 && !fresh.current) return;
              onClose();
              entry.run();
            }}
          />
        ))}
        {note && <p className="px-4 pt-2 pb-3 text-xs text-zinc-500">{note}</p>}
      </div>
    </Sheet>
  );
}

function Entry({
  entry,
  icons,
  first,
  onChoose,
}: {
  readonly entry: MenuEntry;
  /** Some entries have icons: keep the space where this one's would be. */
  readonly icons: boolean;
  /** Gets focus when the menu opens. */
  readonly first: boolean;
  readonly onChoose: (event: { readonly detail: number }) => void;
}) {
  return (
    <>
      {entry.divider && (
        <div
          role="separator"
          className="my-1 border-t border-zinc-200 dark:border-zinc-800"
        />
      )}
      <button
        type="button"
        role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={entry.checked}
        tabIndex={-1}
        disabled={entry.disabled}
        data-initial-focus={first ? "" : undefined}
        onClick={onChoose}
        className={`flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none disabled:opacity-40 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 pointer-coarse:min-h-11 pointer-coarse:px-4 ${
          entry.danger
            ? "text-red-700 dark:text-red-400"
            : "text-zinc-800 dark:text-zinc-100"
        }`}
      >
        {entry.checked ? (
          <Icon
            name="check"
            className="size-4 shrink-0 text-blue-600 dark:text-blue-400"
          />
        ) : entry.icon ? (
          <Icon
            name={entry.icon}
            className={`size-4 shrink-0 ${entry.pressed ? "fill-amber-400 text-amber-500" : "text-zinc-500 dark:text-zinc-400"}`}
          />
        ) : (
          icons && <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      </button>
    </>
  );
}
