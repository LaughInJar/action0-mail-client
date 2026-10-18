import { Emitter } from "../lib/emitter";
import { parseBinding, strokeFromEvent } from "./keys";

/** A keyboard command. */
export interface Command {
  /** Unique id, e.g. `list.next`. */
  readonly id: string;
  /** Heading in the shortcut overlay. */
  readonly group: string;
  readonly description: string;
  /** Bindings in the notation of `keys.ts`, e.g. `["j", "ArrowDown"]` or `["g i"]`. */
  readonly keys: readonly string[];
  /** The command only runs (and only shows in the overlay) while this returns true. */
  readonly when?: () => boolean;
  readonly run: (event: KeyboardEvent) => void;
}

interface Entry {
  readonly command: Command;
  readonly sequences: readonly (readonly string[])[];
}

/** How long a started sequence (like `g …`) waits for its next stroke. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Central registry of keyboard commands. Components register commands while
 * mounted; the most recently registered command wins when bindings collide.
 */
export class CommandRegistry {
  readonly #emitter = new Emitter();
  #entries: readonly Entry[] = [];
  #version = 0;
  #pending: string[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** Registers commands; returns a function that unregisters them. */
  register(commands: readonly Command[]): () => void {
    const added: readonly Entry[] = commands.map((command) => ({
      command,
      sequences: command.keys.map(parseBinding),
    }));
    this.#entries = [...this.#entries, ...added];
    this.#changed();
    return () => {
      this.#entries = this.#entries.filter((entry) => !added.includes(entry));
      this.#changed();
    };
  }

  /** Increments whenever commands are registered or unregistered. */
  get version(): number {
    return this.#version;
  }

  /** All registered commands, once per id (for the shortcut overlay). */
  list(): Command[] {
    const seen = new Set<string>();
    const result: Command[] = [];
    for (const { command } of [...this.#entries].reverse()) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      result.push(command);
    }
    return result.reverse();
  }

  subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  /**
   * Handles a keydown event. Returns true (and prevents the default action)
   * if a command ran or a sequence was started.
   */
  handleKeyDown = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing) return false;
    if (isEditable(event.target)) return false;
    const stroke = strokeFromEvent(event);
    if (stroke === undefined) return false;
    if (isActivationKey(stroke) && isInteractive(event.target)) return false;

    if (this.#pending.length > 0) {
      const handled = this.#dispatch([...this.#pending, stroke], event);
      if (handled) return true;
    }
    return this.#dispatch([stroke], event);
  };

  #dispatch(sequence: readonly string[], event: KeyboardEvent): boolean {
    this.#resetPending();
    const active = [...this.#entries]
      .reverse()
      .filter(({ command }) => command.when?.() !== false);

    for (const { command, sequences } of active) {
      if (sequences.some((candidate) => equals(candidate, sequence))) {
        event.preventDefault();
        command.run(event);
        return true;
      }
    }

    const isPrefix = active.some(({ sequences }) =>
      sequences.some(
        (candidate) =>
          candidate.length > sequence.length &&
          equals(candidate.slice(0, sequence.length), sequence),
      ),
    );
    if (isPrefix) {
      event.preventDefault();
      this.#pending = [...sequence];
      this.#timer = setTimeout(() => {
        this.#resetPending();
      }, SEQUENCE_TIMEOUT_MS);
      return true;
    }
    return false;
  }

  #changed() {
    this.#version++;
    this.#emitter.emit();
  }

  #resetPending() {
    clearTimeout(this.#timer);
    this.#pending = [];
  }
}

function equals(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((stroke, index) => stroke === b[index])
  );
}

/** Space and Enter belong to focused buttons, links and form controls. */
function isActivationKey(stroke: string): boolean {
  return stroke === "Space" || stroke === "shift+Space" || stroke === "Enter";
}

// Duck-typed on purpose: events forwarded from the mail iframe carry elements
// of another realm, for which `instanceof HTMLElement` is false.
interface ElementLike {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute(name: string): string | null;
}

function asElement(target: EventTarget | null): ElementLike | undefined {
  return target !== null &&
    typeof (target as Partial<ElementLike>).tagName === "string"
    ? (target as unknown as ElementLike)
    : undefined;
}

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
]);

function isEditable(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (
    tag === "textarea" ||
    tag === "select" ||
    element.isContentEditable === true
  )
    return true;
  return (
    tag === "input" &&
    !NON_TEXT_INPUTS.has((element.getAttribute("type") ?? "text").toLowerCase())
  );
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "menuitem",
  "switch",
  "tab",
  "treeitem",
]);

function isInteractive(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (["button", "a", "input", "select", "textarea", "summary"].includes(tag))
    return true;
  return INTERACTIVE_ROLES.has(element.getAttribute("role") ?? "");
}
