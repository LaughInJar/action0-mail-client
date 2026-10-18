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
  /** Toggle state; filled icon and `aria-pressed` when true. */
  readonly pressed?: boolean;
  /** Red, for destructive actions. */
  readonly danger?: boolean;
}

/** Square icon-only button; 44px touch target on touch devices. */
export function IconButton({
  label,
  icon,
  onClick,
  disabled = false,
  spinning = false,
  pressed,
  danger = false,
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
      className={`grid size-9 shrink-0 place-items-center rounded-md hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800 pointer-coarse:size-11 ${danger ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-300"}`}
    >
      <Icon
        name={icon}
        className={`size-4 ${spinning ? "animate-spin" : ""} ${pressed ? "fill-amber-400 text-amber-500" : ""}`}
      />
    </button>
  );
}
