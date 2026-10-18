/**
 * Storage access that never throws. Browsers can deny storage entirely
 * (privacy modes, blocked site data), in which case these return `undefined`
 * and the app keeps working without persistence.
 */

/** `window.localStorage`, or `undefined` if it is unavailable. Only for settings and UI state. */
export function getLocalStorage(): Storage | undefined {
  return probe(() => window.localStorage);
}

/** `window.sessionStorage`, or `undefined` if it is unavailable. */
export function getSessionStorage(): Storage | undefined {
  return probe(() => window.sessionStorage);
}

function probe(get: () => Storage): Storage | undefined {
  try {
    const storage = get();
    const key = "a0.probe";
    storage.setItem(key, key);
    storage.removeItem(key);
    return storage;
  } catch {
    return undefined;
  }
}

/** Reads and parses a JSON value; returns `undefined` if missing or malformed. */
export function readJson(storage: Storage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined
      ? undefined
      : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/** Serializes and writes a JSON value; silently ignores quota and access errors. */
export function writeJson(
  storage: Storage | undefined,
  key: string,
  value: unknown,
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best effort.
  }
}

/** Removes a key; silently ignores access errors. */
export function removeKey(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Persistence is best effort.
  }
}
