import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "../common/useFocusTrap";
import { useCoarsePointer } from "./useBreakpoint";
import { useT } from "../../i18n/context";

/** Props of {@link Drawer}. */
export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly children: ReactNode;
}

/** Slide-over panel from the left (the folder tree on medium screens). */
export function Drawer({ open, onClose, label, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const t = useT();
  // On touch screens, focusing the first field (the folder filter) would pop
  // up the on-screen keyboard every time.
  const coarse = useCoarsePointer();
  useFocusTrap(panelRef, open, onClose, { focusContainer: coarse });

  return (
    <div className={open ? "" : "pointer-events-none"} inert={!open}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t.layout.closePanel(label)}
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/30 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] pt-[env(safe-area-inset-top)] pb-[var(--safe-bottom)] pl-[env(safe-area-inset-left)] shadow-xl transition-transform focus:outline-none ${open ? "translate-x-0" : "-translate-x-full"} bg-zinc-50 dark:bg-zinc-900`}
      >
        {children}
      </div>
    </div>
  );
}
