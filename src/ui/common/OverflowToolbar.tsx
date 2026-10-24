import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ToolbarItem } from "../actions/mailActionItems";
import { fittingItems, GAP } from "./toolbarFit";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { useFocusTrap } from "./useFocusTrap";

/** Props of {@link OverflowToolbar}. */
export interface OverflowToolbarProps {
  /** Accessible name of the toolbar. */
  readonly label: string;
  /** Accessible name of the ⋯ button and its menu. */
  readonly moreLabel: string;
  /** Always shown at the start (Back on phones). */
  readonly leading?: ReactNode;
  readonly items: readonly ToolbarItem[];
}

/**
 * A row of icon buttons that shows what fits and puts the rest into a ⋯
 * menu (see {@link fittingItems}), measured again whenever its width
 * changes. Without ResizeObserver everything shows.
 */
export function OverflowToolbar({
  label,
  moreLabel,
  leading,
  items,
}: OverflowToolbarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [space, setSpace] = useState<{
    readonly width: number;
    readonly button: number;
  } | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    // Called once right away, then on every change of the row's size.
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(row);
      const padding =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const lead = leadRef.current?.offsetWidth;
      // The spacer between the leading part and the buttons has gaps too.
      const taken = lead === undefined ? GAP : lead + 2 * GAP;
      const width = row.clientWidth - padding - taken;
      const measured = probeRef.current?.offsetWidth ?? 0;
      const button = measured > 0 ? measured : 36;
      setSpace((current) =>
        current?.width === width && current.button === button
          ? current
          : { width, button },
      );
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, []);

  const shown = space
    ? fittingItems(items, space.width, space.button)
    : new Set(items.map((item) => item.id));
  const visible = items.filter((item) => shown.has(item.id));
  const hidden = items.filter((item) => !shown.has(item.id));
  const answers = visible.filter((item) => item.group === "answer");
  const mail = visible.filter((item) => item.group === "mail");

  return (
    <div
      ref={rowRef}
      role="group"
      aria-label={label}
      className="relative flex min-h-12 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800"
    >
      {leading && (
        <div ref={leadRef} className="flex shrink-0 items-center gap-1">
          {leading}
        </div>
      )}
      <div className="flex-1" />
      {answers.map(button)}
      {answers.length > 0 && mail.length > 0 && (
        <span className="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />
      )}
      {mail.map(button)}
      {hidden.length > 0 && <MoreMenu label={moreLabel} items={hidden} />}
      {/* Measures a button (36px, 44px on touch screens). */}
      <span
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute size-9 pointer-coarse:size-11"
      />
    </div>
  );
}

function button(item: ToolbarItem) {
  return (
    <IconButton
      key={item.id}
      label={item.label}
      icon={item.icon}
      onClick={item.run}
      {...(item.disabled ? { disabled: true } : {})}
      {...(item.pressed === undefined ? {} : { pressed: item.pressed })}
      {...(item.danger ? { danger: true } : {})}
    />
  );
}

/** The ⋯ button and its menu of the actions that didn't fit. */
function MoreMenu({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly ToolbarItem[];
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
  };
  // Focuses the first item, Esc closes, focus returns to ⋯ afterwards.
  useFocusTrap(menuRef, open, close);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
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
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="grid size-9 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:size-11"
      >
        <Icon name="more" className="size-4" />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            data-own-keys=""
            onKeyDown={onKeyDown}
            className="absolute top-full right-0 z-50 mt-1 min-w-56 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                data-initial-focus={index === 0 ? "" : undefined}
                onClick={() => {
                  close();
                  item.run();
                }}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none disabled:opacity-40 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 pointer-coarse:min-h-11 ${
                  item.danger
                    ? "text-red-700 dark:text-red-400"
                    : "text-zinc-800 dark:text-zinc-100"
                }`}
              >
                <Icon
                  name={item.icon}
                  className={`size-4 shrink-0 ${item.pressed ? "fill-amber-400 text-amber-500" : "text-zinc-500 dark:text-zinc-400"}`}
                />
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
