import { Icon, type IconName } from "./Icon";

/** Props of {@link IconButton}. */
export interface IconButtonProps {
  /** Accessible name, also shown as tooltip. */
  readonly label: string;
  readonly icon: IconName;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Spins the icon (e.g. while refreshing). */
  readonly spinning?: boolean;
}

/** Square icon-only button; 44px touch target on touch devices. */
export function IconButton({
  label,
  icon,
  onClick,
  disabled = false,
  spinning = false,
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-9 shrink-0 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:size-11"
    >
      <Icon
        name={icon}
        className={`size-4 ${spinning ? "animate-spin" : ""}`}
      />
    </button>
  );
}
