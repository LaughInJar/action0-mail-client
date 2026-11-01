import { useEffect, useMemo } from "react";
import { useT } from "../../i18n/context";
import { useCommands } from "../../keyboard/context";
import { isModalOpen, ownsKeys } from "../../keyboard/modal";
import type { Command } from "../../keyboard/registry";
import { useUiStore } from "../../state/context";

/**
 * Ctrl/⌘+K opens the command palette, also from text fields (before the
 * browser's own Ctrl+K), and closes it again. Not inside the composer,
 * whose text uses it for links, nor over another dialog. The command is
 * listed in the shortcut help, and the mail's frame forwards it.
 */
export function usePaletteShortcut(): void {
  const store = useUiStore();
  const t = useT();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
        return;
      if (event.key.toLowerCase() !== "k" || event.isComposing) return;
      const { paletteOpen, setPaletteOpen } = store.getState();
      if (paletteOpen) {
        event.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (ownsKeys(event.target) || isModalOpen()) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    // Capture: before the app's shortcuts, which leave text fields alone.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [store]);

  useCommands(
    useMemo(
      (): Command[] => [
        {
          id: "palette.open",
          group: "general",
          description: t.shortcuts.palette,
          keys: ["ctrl+k", "meta+k"],
          run: () => {
            store.getState().setPaletteOpen(true);
          },
        },
      ],
      [store, t],
    ),
  );
}
