import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { useT } from "../../i18n/context";

/** Props of {@link Sheet}. */
export interface SheetProps {
  /** Id of the element that names the dialog. */
  readonly labelledBy: string;
  /** Escape (and, unless `onBackdrop` is given, a click outside). */
  readonly onEscape: () => void;
  /** A click outside, if it should do something other than `onEscape`. */
  readonly onBackdrop?: () => void;
  /** Accessible name of the backdrop button; "Close" by default. */
  readonly backdropLabel?: string;
  /** Focus the dialog itself instead of its first field (keeps the phone keyboard closed). */
  readonly focusContainer?: boolean;
  /**
   * Width on larger screens; `page` is a large dialog there and fills the
   * screen on phones.
   */
  readonly size?: "md" | "lg" | "page";
  readonly children: ReactNode;
}

const SIZES: Readonly<Record<NonNullable<SheetProps["size"]>, string>> = {
  md: "max-h-[85dvh] rounded-t-2xl sm:top-[10vh] sm:max-w-md",
  lg: "max-h-[85dvh] rounded-t-2xl sm:top-[10vh] sm:max-w-lg",
  page: "top-0 pt-[env(safe-area-inset-top)] sm:top-[6vh] sm:h-[88vh] sm:max-w-3xl sm:pt-0",
};

/**
 * A modal dialog: centered on larger screens, a bottom sheet on phones.
 * Keeps focus inside, closes on Escape, and blocks the app's shortcuts while
 * open (see `AppProviders`).
 */
export function Sheet({
  labelledBy,
  onEscape,
  onBackdrop,
  backdropLabel,
  focusContainer = false,
  size = "md",
  children,
}: SheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const t = useT();
  useFocusTrap(dialogRef, true, onEscape, { focusContainer });

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        tabIndex={-1}
        aria-label={backdropLabel ?? t.common.close}
        onClick={onBackdrop ?? onEscape}
        className="absolute inset-0 bg-black/30"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 flex flex-col bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl focus:outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:w-full sm:-translate-x-1/2 sm:rounded-xl sm:pb-0 dark:bg-zinc-900 ${SIZES[size]}`}
      >
        {children}
      </div>
    </div>
  );
}
