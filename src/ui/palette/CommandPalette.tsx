import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import { MAX_PALETTE_RECENT } from "../../state/settings";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { paletteGroups, withRecent, type PaletteItem } from "./paletteItems";
import { usePaletteItems } from "./usePaletteItems";

/** How far Page Up / Page Down move in the list. */
const PAGE = 8;

/** The command palette while it's open (Ctrl/⌘+K, or the ⌘ button). */
export function PaletteHost() {
  const open = useUi((state) => state.paletteOpen);
  return open ? <CommandPalette /> : null;
}

/**
 * One field to go anywhere, do anything that applies right now, or search
 * mail: a dialog near the top on larger screens, the whole screen on
 * phones. ↑/↓ move, Enter chooses, Esc closes; an empty field lists the
 * recent choices first.
 */
function CommandPalette() {
  const t = useT();
  const p = t.palette;
  const id = useId();
  const store = useUiStore();
  const recent = useUi((state) => state.settings.paletteRecent);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const groups = paletteGroups(usePaletteItems(query), query, recent);
  const shown = groups.flatMap((group) => group.items);
  const at = Math.min(cursor, Math.max(0, shown.length - 1));
  const optionId = (index: number) => `${id}-option-${String(index)}`;

  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
    // The ids only change with the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const close = () => {
    store.getState().setPaletteOpen(false);
  };
  const choose = (item: PaletteItem) => {
    if (item.remember !== false)
      store.getState().updateSettings({
        paletteRecent: withRecent(recent, item.id, MAX_PALETTE_RECENT),
      });
    close();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    const move = (to: number) => {
      event.preventDefault();
      setCursor(to);
    };
    switch (event.key) {
      case "ArrowDown":
        move(at >= last ? 0 : at + 1);
        break;
      case "ArrowUp":
        move(at <= 0 ? last : at - 1);
        break;
      case "PageDown":
        move(Math.min(last, at + PAGE));
        break;
      case "PageUp":
        move(Math.max(0, at - PAGE));
        break;
      case "Enter": {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        const chosen = shown[at];
        if (chosen) choose(chosen);
        break;
      }
    }
  };

  let index = 0;
  return (
    <Sheet labelledBy={`${id}-title`} onEscape={close} size="palette">
      <h2 id={`${id}-title`} className="sr-only">
        {p.title}
      </h2>
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-1.5 pr-2 pl-4 dark:border-zinc-800">
        <Icon name="search" className="size-4 shrink-0 text-zinc-500" />
        <input
          data-initial-focus
          type="text"
          role="combobox"
          aria-label={p.title}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown[at] ? optionId(at) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={p.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-zinc-400"
        />
        <IconButton label={p.close} icon="x" onClick={close} />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={p.title}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
      >
        {groups.map((group) => (
          <div
            key={group.section}
            role="group"
            aria-labelledby={`${id}-${group.section}`}
          >
            <div
              id={`${id}-${group.section}`}
              className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase"
            >
              {p.sections[group.section]}
            </div>
            {group.items.map((item) => {
              const own = index++;
              return (
                // The field's ↑/↓ and Enter are the keyboard's way.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <div
                  key={item.id}
                  id={optionId(own)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={own === at}
                  onMouseDown={(event) => {
                    // The field keeps the focus.
                    event.preventDefault();
                  }}
                  onMouseMove={() => {
                    if (own !== at) setCursor(own);
                  }}
                  onClick={() => {
                    choose(item);
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 text-sm aria-selected:bg-blue-100 dark:aria-selected:bg-blue-500/20 pointer-coarse:min-h-11"
                >
                  <Icon
                    name={item.icon}
                    className="size-4 shrink-0 text-zinc-500 dark:text-zinc-400"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {item.label}
                    {item.detail && (
                      <span className="ml-2 text-xs text-zinc-500">
                        {item.detail}
                      </span>
                    )}
                  </span>
                  {item.shortcut && (
                    <kbd className="shrink-0 rounded border border-b-2 border-zinc-300 bg-zinc-50 px-1.5 font-sans text-xs text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 pointer-coarse:hidden">
                      {item.shortcut}
                    </kbd>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {shown.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-zinc-500">{p.noMatch}</p>
        )}
      </div>
    </Sheet>
  );
}
