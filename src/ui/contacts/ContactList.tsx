import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { AccountId } from "../../core/ids";
import type { ContactRow } from "../../data/contacts";
import { useT } from "../../i18n/context";
import type { MenuPosition } from "../../state/uiStore";
import {
  atPointer,
  belowElement,
  isMenuKey,
  wantsAppMenu,
} from "../common/menuPosition";
import { Icon } from "../common/Icon";
import { useLongPress } from "../messages/useLongPress";
import { ContactAvatar } from "./ContactAvatar";

/** Id of the contact search field (`/` focuses it). */
export const CONTACT_SEARCH_ID = "contact-search";

const rowDomId = (index: number) => `contact-row-${String(index)}`;

/** How a row was chosen. */
export interface RowChoice {
  readonly shift: boolean;
  /** Ctrl or ⌘. */
  readonly toggle: boolean;
  /** Not with a mouse (a tap). */
  readonly touch: boolean;
}

/**
 * The contacts of a list, by name with letter headings: a multi-select
 * listbox. A click opens a contact; Shift, Ctrl/⌘ and taps while
 * selecting change the selection; right-click, a long press or the Menu
 * key open the menu.
 */
export function ContactList({
  label,
  rows,
  openKey,
  selected,
  colors,
  status,
  onChoose,
  onMenu,
}: {
  label: string;
  rows: readonly ContactRow[];
  openKey: string | undefined;
  selected: ReadonlySet<string>;
  /** Account colours, in All contacts (rows of several sources). */
  colors: ReadonlyMap<AccountId, string> | null;
  /** Shown instead of the rows when there are none (loading, empty). */
  status: ReactNode;
  onChoose: (row: ContactRow, how: RowChoice) => void;
  onMenu: (row: ContactRow, at: MenuPosition) => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const pointerType = useRef("mouse");

  const rowOf = (target: EventTarget | null): ContactRow | undefined => {
    const element = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-row-index]",
    );
    const index = Number(element?.dataset.rowIndex ?? NaN);
    return Number.isNaN(index) ? undefined : rows[index];
  };

  const longPress = useLongPress((target, at) => {
    const row = rowOf(target);
    if (row) onMenu(row, atPointer(at));
  });

  const openIndex =
    openKey === undefined ? -1 : rows.findIndex((row) => row.key === openKey);

  // Follow the open contact when it moves (j/k).
  useEffect(() => {
    if (openIndex === -1) return;
    listRef.current
      ?.querySelector(`#${rowDomId(openIndex)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [openIndex]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (longPress.consumeClick()) return;
    const row = rowOf(event.target);
    if (!row) return;
    onChoose(row, {
      shift: event.shiftKey,
      toggle: event.ctrlKey || event.metaKey,
      touch: pointerType.current !== "mouse",
    });
  };

  if (rows.length === 0) return <div className="p-4">{status}</div>;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      aria-activedescendant={openIndex === -1 ? undefined : rowDomId(openIndex)}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!isMenuKey(event) || openIndex === -1) return;
        const row = rows[openIndex];
        const element = listRef.current?.querySelector(
          `#${rowDomId(openIndex)}`,
        );
        if (!row || !element) return;
        event.preventDefault();
        onMenu(row, belowElement(element));
      }}
      onPointerDown={(event) => {
        pointerType.current = event.pointerType;
        longPress.onPointerDown(event);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={(event) => {
        const row = rowOf(event.target);
        if (!row || pointerType.current !== "mouse" || !wantsAppMenu(event)) {
          longPress.onContextMenu(event);
          return;
        }
        event.preventDefault();
        onMenu(row, atPointer(event));
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24 focus:outline-none"
    >
      {rows.map((row, index) => {
        const open = row.key === openKey;
        const chosen = selected.has(row.key);
        const heading =
          index === 0 || rows[index - 1]?.letter !== row.letter
            ? row.letter
            : null;
        const detail =
          row.contact.emails[0]?.value ??
          row.contact.phones[0]?.value ??
          row.contact.organization.company;
        const color =
          colors && row.source.accountId
            ? colors.get(row.source.accountId)
            : undefined;
        return (
          <div key={row.key}>
            {heading !== null && (
              <div
                aria-hidden="true"
                className="sticky top-0 z-[1] bg-white/95 px-4 pt-2 pb-0.5 text-xs font-semibold text-zinc-500 dark:bg-zinc-950/95 dark:text-zinc-400"
              >
                {heading}
              </div>
            )}
            <div
              id={rowDomId(index)}
              role="option"
              aria-selected={chosen || (selected.size === 0 && open)}
              aria-current={open ? "true" : undefined}
              data-row-index={index}
              className={`relative flex cursor-default items-center gap-3 px-4 py-1.5 select-none [contain-intrinsic-size:auto_3rem] [content-visibility:auto] pointer-coarse:min-h-14 ${
                chosen
                  ? "bg-blue-100 dark:bg-blue-500/25"
                  : open
                    ? "bg-zinc-200/70 dark:bg-zinc-800"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              {color && (
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: color }}
                  className="absolute inset-y-1 left-0.5 w-1 rounded-full"
                />
              )}
              {chosen ? (
                <span
                  aria-hidden="true"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white"
                >
                  <Icon name="check" className="size-4" />
                </span>
              ) : (
                <ContactAvatar
                  source={row.source}
                  contact={row.contact}
                  name={row.name}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {row.name || t.contacts.unnamed}
                </div>
                {detail && detail !== row.name && (
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {detail}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
