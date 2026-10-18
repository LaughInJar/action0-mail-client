import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";

/** Props of {@link Sheet}. */
export interface SheetProps {
  /** Id of the element that names the dialog. */
  readonly labelledBy: string;
  /** Escape (and, unless `onBackdrop` is given, a click outside). */
  readonly onEscape: () => void;
  /** A click outside, if it should do something other than `onEscape`. */
  readonly onBackdrop?: () => void;
  /** Accessible name of the backdrop button. */
  readonly backdropLabel?: string;
  /** Focus the dialog itself instead of its first field (keeps the phone keyboard closed). */
  readonly focusContainer?: boolean;
  /** Width on larger screens. */
  readonly size?: "md" | "lg";
  readonly children: ReactNode;
}

/**
 * A modal dialog: centered on larger screens, a bottom sheet on phones.
 * Keeps focus inside, closes on Escape, and blocks the app's shortcuts while
 * open (see `AppProviders`).
 */
export function Sheet({
  labelledBy,
  onEscape,
  onBackdrop,
  backdropLabel = "Close",
  focusContainer = false,
  size = "md",
  children,
}: SheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onEscape, { focusContainer });

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        tabIndex={-1}
        aria-label={backdropLabel}
        onClick={onBackdrop ?? onEscape}
        className="absolute inset-0 bg-black/30"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl focus:outline-none sm:inset-x-auto sm:top-[10vh] sm:bottom-auto sm:left-1/2 sm:w-full sm:-translate-x-1/2 sm:rounded-xl sm:pb-0 dark:bg-zinc-900 ${size === "lg" ? "sm:max-w-lg" : "sm:max-w-md"}`}
      >
        {children}
      </div>
    </div>
  );
}
