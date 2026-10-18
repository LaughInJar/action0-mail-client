import {
  useEffect,
  useId,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  formatAddress,
  isValidAddress,
  parseAddressInput,
} from "../../core/addresses";
import { uniqueAddresses } from "../../core/compose";
import type { AccountId } from "../../core/ids";
import type { EmailAddress } from "../../core/model";
import { useAddressSuggestions } from "../../data/drafts";
import { Icon } from "../common/Icon";

/** Props of {@link AddressField}. */
export interface AddressFieldProps {
  /** Id of the text input (for labels and focusing). */
  readonly id: string;
  readonly label: string;
  readonly accountId: AccountId;
  readonly value: readonly EmailAddress[];
  readonly onChange: (next: EmailAddress[]) => void;
  /** Shown at the end of the row (e.g. the Cc/Bcc buttons). */
  readonly trailing?: ReactNode;
}

const SUGGEST_DELAY_MS = 150;

/**
 * Recipients as chips plus a text input with suggestions (an ARIA
 * combobox). Comma, semicolon, Enter or Tab turn the text into chips;
 * pasted lists are split; invalid addresses stay, marked red, to be fixed.
 * Backspace in the empty input takes the last chip back for editing.
 */
export function AddressField({
  id,
  label,
  accountId,
  value,
  onChange,
  trailing,
}: AddressFieldProps) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  // Look up suggestions once typing pauses briefly.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text);
    }, SUGGEST_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
  const { suggestions, notice } = useAddressSuggestions(
    accountId,
    open ? query : "",
  );
  const taken = new Set(value.map((a) => a.address.toLowerCase()));
  const options = text.trim()
    ? suggestions.filter((s) => !taken.has(s.address.toLowerCase()))
    : [];
  const showList = open && (options.length > 0 || notice !== undefined);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const add = (addresses: readonly EmailAddress[]) => {
    const fresh = uniqueAddresses(addresses, value);
    if (fresh.length > 0) onChange([...value, ...fresh]);
    setText("");
    setActive(0);
  };

  const commitText = (raw: string): boolean => {
    const entries = parseAddressInput(raw);
    if (entries.length === 0) return false;
    add(entries.map((entry) => entry.address ?? { address: entry.raw }));
    return true;
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const option = showList ? options[activeIndex] : undefined;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!showList || options.length === 0) return;
        setActive(
          (activeIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            options.length) %
            options.length,
        );
        break;
      case "Enter":
        if (option) add([option]);
        else if (!commitText(text)) return;
        break;
      case "Tab":
        if (option && text.trim()) add([option]);
        else commitText(text);
        // Tab still moves on.
        return;
      case ",":
      case ";":
        // Inside a quoted name these are just characters.
        if ((text.match(/"/g)?.length ?? 0) % 2 === 1 || !text.trim()) return;
        commitText(text);
        break;
      case "Backspace": {
        const last = value.at(-1);
        if (text !== "" || !last) return;
        remove(value.length - 1);
        setText(formatAddress(last));
        break;
      }
      case "Escape":
        if (!showList) return;
        setOpen(false);
        // Close the list, not the composer.
        event.stopPropagation();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!/[,;\n]/.test(pasted) && parseAddressInput(pasted).length <= 1) return;
    event.preventDefault();
    commitText(`${text}${pasted}`);
  };

  return (
    <div className="relative flex items-start gap-2 border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
      <label
        htmlFor={id}
        className="w-8 shrink-0 py-1.5 text-sm text-zinc-500 pointer-coarse:py-3"
      >
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((address, index) => {
          const valid = isValidAddress(address.address);
          const shown = address.name ?? address.address;
          return (
            <span
              key={`${address.address}-${String(index)}`}
              title={valid ? formatAddress(address) : "Not a valid address"}
              className={`flex max-w-full items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5 text-sm ${
                valid
                  ? "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                  : "bg-red-100 text-red-800 ring-1 ring-red-400 dark:bg-red-950 dark:text-red-200"
              }`}
            >
              <span className="truncate">{shown}</span>
              {!valid && <span className="sr-only">(not a valid address)</span>}
              <button
                type="button"
                aria-label={`Remove ${shown}`}
                onClick={() => {
                  remove(index);
                }}
                className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 pointer-coarse:size-8"
              >
                <Icon name="x" className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && options.length > 0
              ? `${listId}-${String(activeIndex)}`
              : undefined
          }
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="email"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            setOpen(false);
            commitText(text);
          }}
          className="min-w-32 flex-1 bg-transparent py-1 text-sm outline-none pointer-coarse:min-h-11"
        />
      </div>
      {trailing}
      {showList && (
        <div className="absolute top-full right-3 left-12 z-10 mt-0.5 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div id={listId} role="listbox" aria-label="Suggestions">
            {options.map((option, index) => (
              // Clicks are fine on options; the combobox input handles the keyboard.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <div
                key={option.address}
                id={`${listId}-${String(index)}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                // Keep focus in the input while picking.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  add([option]);
                }}
                className={`cursor-default px-3 py-1.5 text-sm pointer-coarse:py-3 ${
                  index === activeIndex
                    ? "bg-blue-50 dark:bg-blue-500/20"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                }`}
              >
                {option.name && (
                  <span className="font-medium">{option.name} </span>
                )}
                <span className="text-zinc-500">{option.address}</span>
              </div>
            ))}
          </div>
          {notice && (
            <p className="border-t border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700">
              {notice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
