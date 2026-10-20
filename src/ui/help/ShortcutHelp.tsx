import { useId, useRef } from "react";
import { formatBinding } from "../../keyboard/keys";
import { useRegisteredCommands } from "../../keyboard/context";
import type { Command, CommandGroup } from "../../keyboard/registry";
import { useUi } from "../../state/context";
import { useFocusTrap } from "../common/useFocusTrap";
import { IconButton } from "../common/IconButton";
import { useT } from "../../i18n/context";

const GROUP_ORDER: readonly CommandGroup[] = [
  "list",
  "actions",
  "reading",
  "writing",
  "goTo",
  "search",
  "calendar",
  "general",
];
const groupRank = (group: CommandGroup) => {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
};

/** Overlay listing all keyboard shortcuts, generated from the command registry. */
export function ShortcutHelp() {
  const open = useUi((state) => state.helpOpen);
  if (!open) return null;
  return <ShortcutDialog />;
}

function ShortcutDialog() {
  const setHelpOpen = useUi((state) => state.setHelpOpen);
  const registry = useRegisteredCommands();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const t = useT();
  const close = () => {
    setHelpOpen(false);
  };
  useFocusTrap(dialogRef, true, close);

  const groups = new Map<CommandGroup, Command[]>();
  for (const command of registry.list()) {
    const group = groups.get(command.group) ?? [];
    group.push(command);
    groups.set(command.group, group);
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t.common.close}
        onClick={close}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-2xl focus:outline-none dark:bg-zinc-900"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            {t.shortcuts.title}
          </h2>
          <IconButton label={t.common.close} icon="x" onClick={close} />
        </div>
        {[...groups]
          .sort(([a], [b]) => groupRank(a) - groupRank(b))
          .map(([group, commands]) => (
            <section key={group} className="mb-4">
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                {t.shortcuts.groups[group]}
              </h3>
              <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {commands.map((command) => (
                  <div
                    key={command.id}
                    className="flex items-center justify-between gap-4 py-1.5 text-sm"
                  >
                    <dt>{command.description}</dt>
                    <dd className="flex shrink-0 flex-wrap justify-end gap-1">
                      {command.keys.map((binding) => (
                        <kbd
                          key={binding}
                          className="rounded border border-b-2 border-zinc-300 bg-zinc-50 px-1.5 font-sans text-xs dark:border-zinc-600 dark:bg-zinc-800"
                        >
                          {formatBinding(binding, t.shortcuts.keys)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        <p className="text-xs text-zinc-500">
          {t.shortcuts.treeMenuHint.before}{" "}
          <kbd className="font-sans font-semibold">
            {t.shortcuts.keys.shift}
          </kbd>
          +<kbd className="font-sans font-semibold">F10</kbd>{" "}
          {t.shortcuts.treeMenuHint.after}
        </p>
      </div>
    </div>
  );
}
