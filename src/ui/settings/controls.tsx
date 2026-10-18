import { useId, type ReactNode } from "react";

/** One choice of a {@link ChoiceGroup}. */
export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/** Props of {@link ChoiceGroup}. */
export interface ChoiceGroupProps<T extends string> {
  readonly legend: string;
  readonly value: T;
  readonly choices: readonly Choice<T>[];
  readonly onChange: (value: T) => void;
  /** Shown under the choices. */
  readonly children?: ReactNode;
}

/** A setting with a few choices: native radio buttons with explanations. */
export function ChoiceGroup<T extends string>({
  legend,
  value,
  choices,
  onChange,
  children,
}: ChoiceGroupProps<T>) {
  const name = useId();
  return (
    <fieldset className="space-y-0.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {choices.map((choice) => (
        <label
          key={choice.value}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-100 has-checked:bg-blue-50 dark:hover:bg-zinc-800/60 dark:has-checked:bg-blue-500/15 pointer-coarse:min-h-11"
        >
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => {
              onChange(choice.value);
            }}
            className="mt-0.5 size-4 shrink-0 accent-blue-600"
          />
          <span className="min-w-0 text-sm">
            {choice.label}
            {choice.hint && (
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                {choice.hint}
              </span>
            )}
          </span>
        </label>
      ))}
      {children}
    </fieldset>
  );
}

/** A titled group of settings. */
export function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-4 space-y-5 border-b border-zinc-200 py-5 last:border-b-0 dark:border-zinc-800"
    >
      <h3
        id={`${id}-title`}
        className="text-xs font-semibold tracking-wide text-zinc-500 uppercase"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}
