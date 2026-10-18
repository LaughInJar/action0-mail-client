import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/context";
import type { ComposeActions } from "./useComposeActions";

const hasFiles = (event: DragEvent) => {
  // Synthetic drag events (tests, some browsers' internal drags) may lack types.
  const types: readonly string[] | undefined = event.dataTransfer?.types;
  return types?.includes("Files") === true;
};

/**
 * Files dropped on the app: they start a new mail (or, while a composer is
 * open, are attached to it). The browser never opens a dropped file in
 * place of the app. Returns whether to show the "drop to start a mail"
 * overlay (only while no composer is open).
 */
export function useFileDrop(actions: ComposeActions): boolean {
  const composerOpen = useUi((state) => state.composer !== null);
  const [dragging, setDragging] = useState(false);
  const attach = useRef(actions.attachFiles);
  useEffect(() => {
    attach.current = actions.attachFiles;
  });

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = 0;
      setDragging(false);
      // The composer handles drops on itself first.
      const handled = event.defaultPrevented;
      event.preventDefault();
      if (!handled) attach.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return dragging && !composerOpen && actions.canCompose;
}
