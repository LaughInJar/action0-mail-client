/** Minimal change notifier, shaped for `useSyncExternalStore`. */
export class Emitter {
  readonly #listeners = new Set<() => void>();

  /** Registers a listener and returns a function that removes it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
