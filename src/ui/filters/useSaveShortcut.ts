import { useEffect, useRef, type RefObject } from "react";

/**
 * Ctrl/⌘+Enter inside `form` calls `save`. Listened for on the document,
 * like the event editor, so fields inside handle keys first.
 */
export function useSaveShortcut(
  form: RefObject<HTMLFormElement | null>,
  save: () => void,
): void {
  const latest = useRef(save);
  useEffect(() => {
    latest.current = save;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        (event.ctrlKey || event.metaKey) &&
        event.target instanceof Node &&
        form.current?.contains(event.target)
      ) {
        event.preventDefault();
        latest.current();
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
    };
  }, [form]);
}
