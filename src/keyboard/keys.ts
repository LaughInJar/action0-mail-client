/**
 * Keystroke notation.
 *
 * A stroke is a key name with optional `ctrl+`, `alt+`, `meta+` prefixes.
 * Printable characters are matched by the character they produce, so
 * Shift is implied by the character itself: `J` is Shift+j, and `?` works
 * on any keyboard layout. Named keys spell Shift out: `shift+ArrowDown`.
 * A binding is one or more strokes separated by spaces, e.g. `g i`.
 */

const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  Spacebar: "Space",
  Esc: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

const IGNORED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Dead",
  "Unidentified",
  "Process",
]);

const MODIFIER_ORDER = ["ctrl", "alt", "meta", "shift"] as const;

/** The stroke a keyboard event represents, or `undefined` for bare modifiers. */
export function strokeFromEvent(event: KeyboardEvent): string | undefined {
  if (IGNORED_KEYS.has(event.key)) return undefined;
  let key = NAMED_KEYS[event.key] ?? event.key;
  const printable = key.length === 1;
  // Ignore Caps Lock: letters follow the Shift key only.
  if (printable && /^[a-z]$/i.test(key)) {
    key = event.shiftKey ? key.toUpperCase() : key.toLowerCase();
  }
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.metaKey) modifiers.push("meta");
  if (event.shiftKey && !printable) modifiers.push("shift");
  return [...modifiers, key].join("+");
}

/** Normalizes one stroke of a binding, e.g. `Shift+j` → `J`, `shift+space` → `shift+Space`. */
export function normalizeStroke(stroke: string): string {
  const parts = stroke.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && stroke.endsWith("+")) key = "+";
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  if (key.toLowerCase() === "space") key = "Space";
  else if (key.toLowerCase() === "esc" || key.toLowerCase() === "escape")
    key = "Escape";
  if (key.length === 1 && /^[a-z]$/i.test(key)) {
    key = modifiers.has("shift") ? key.toUpperCase() : key.toLowerCase();
    modifiers.delete("shift");
  } else if (key.length === 1) {
    modifiers.delete("shift");
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

/** Splits and normalizes a binding into its strokes. */
export function parseBinding(binding: string): string[] {
  return binding.trim().split(/\s+/).map(normalizeStroke);
}

/** Names of keys as printed on keyboards (they differ by language). */
export interface KeyNames {
  readonly ctrl: string;
  readonly alt: string;
  readonly shift: string;
  readonly enter: string;
  readonly delete: string;
  readonly backspace: string;
  readonly space: string;
  readonly home: string;
  readonly end: string;
  readonly escape: string;
  /** Between the strokes of a sequence ("g then i"). */
  readonly then: string;
}

const ENGLISH_KEYS: KeyNames = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  delete: "Delete",
  backspace: "Backspace",
  space: "Space",
  home: "Home",
  end: "End",
  escape: "Esc",
  then: "then",
};

/** Human-readable label of a binding, for the shortcut overlay. */
export function formatBinding(
  binding: string,
  names: KeyNames = ENGLISH_KEYS,
): string {
  const labels: Readonly<Record<string, string>> = {
    ctrl: names.ctrl,
    alt: names.alt,
    meta: "⌘",
    shift: names.shift,
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Escape: names.escape,
    Enter: names.enter,
    Delete: names.delete,
    Backspace: names.backspace,
    Space: names.space,
    " ": names.space,
    Home: names.home,
    End: names.end,
  };
  return parseBinding(binding)
    .map((stroke) =>
      stroke
        .split("+")
        .map((part) => {
          if (part.length === 1 && /[A-Z]/.test(part))
            return `${names.shift}+${part.toLowerCase()}`;
          return labels[part] ?? part;
        })
        .join("+"),
    )
    .join(` ${names.then} `);
}
