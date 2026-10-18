import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { Command, CommandRegistry } from "./registry";

/** Provides the {@link CommandRegistry}. */
export const CommandRegistryContext = createContext<CommandRegistry | null>(
  null,
);

/** The command registry from context. */
export function useCommandRegistry(): CommandRegistry {
  const registry = useContext(CommandRegistryContext);
  if (!registry)
    throw new Error("useCommandRegistry() needs a CommandRegistryContext");
  return registry;
}

/**
 * Registers commands while the component is mounted. Pass a memoized array;
 * read changing state inside `run` (e.g. via `store.getState()`) to keep it
 * stable.
 */
export function useCommands(commands: readonly Command[]): void {
  const registry = useCommandRegistry();
  useEffect(() => registry.register(commands), [registry, commands]);
}

/** Re-renders when commands are registered or unregistered. */
export function useRegisteredCommands(): CommandRegistry {
  const registry = useCommandRegistry();
  useSyncExternalStore(registry.subscribe, () => registry.version);
  return registry;
}
