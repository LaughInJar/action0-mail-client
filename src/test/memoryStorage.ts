/** In-memory `Storage`, for tests that run outside jsdom or need isolation. */
export class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  /** All stored values joined, for "contains no secrets" assertions. */
  dump(): string {
    return [...this.#items].map(([key, value]) => `${key}=${value}`).join("\n");
  }
}
