import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../test/memoryStorage";
import { readTheme, saveTheme, THEME_KEY } from "./theme";
import script from "../../public/theme.js?raw";

describe("theme setting", () => {
  it("reads the saved choice; anything else is system", () => {
    const storage = new MemoryStorage();
    expect(readTheme(storage)).toBe("system");
    expect(readTheme(undefined)).toBe("system");
    storage.setItem(THEME_KEY, "dark");
    expect(readTheme(storage)).toBe("dark");
    storage.setItem(THEME_KEY, "purple");
    expect(readTheme(storage)).toBe("system");
  });

  it("saves light and dark, and forgets the choice for system", () => {
    const storage = new MemoryStorage();
    saveTheme(storage, "light");
    expect(storage.getItem(THEME_KEY)).toBe("light");
    saveTheme(storage, "system");
    expect(storage.getItem(THEME_KEY)).toBeNull();
  });
});

describe("public/theme.js", () => {
  const run = (stored: string | null) => {
    if (stored === null) window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, stored);
    // It runs as a plain script in the page's <head>.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inHead = new Function(script) as () => void;
    inHead();
    return document.documentElement.getAttribute("data-theme");
  };

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies a saved light or dark theme before the app loads", () => {
    expect(run("dark")).toBe("dark");
    expect(run("light")).toBe("light");
  });

  it("leaves system and unknown values to the OS", () => {
    expect(run(null)).toBeNull();
    expect(run("system")).toBeNull();
    expect(run("<script>")).toBeNull();
  });
});
