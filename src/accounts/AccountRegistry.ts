import type { AccountId } from "../core/ids";
import type { ProviderType } from "../core/model";
import { Emitter } from "../lib/emitter";
import { loadAccounts, saveAccounts } from "./accountStorage";
import type { AccountHandle, ProviderModule } from "./types";

/** Options of {@link AccountRegistry}. */
export interface AccountRegistryOptions {
  readonly modules: readonly ProviderModule[];
  /** Where the account list is persisted (localStorage). */
  readonly storage: Storage | undefined;
  /** Called after an account was removed, e.g. to drop its cached data. */
  readonly onRemove?: (accountId: AccountId) => void;
}

/**
 * The connected accounts, each with its auth session and provider.
 * Framework-agnostic; React reads it through `useSyncExternalStore`.
 */
export class AccountRegistry {
  readonly #modules: ReadonlyMap<ProviderType, ProviderModule>;
  readonly #storage: Storage | undefined;
  readonly #onRemove: ((accountId: AccountId) => void) | undefined;
  readonly #emitter = new Emitter();
  #handles: readonly AccountHandle[] = [];

  constructor({ modules, storage, onRemove }: AccountRegistryOptions) {
    this.#modules = new Map(modules.map((module) => [module.type, module]));
    this.#storage = storage;
    this.#onRemove = onRemove;
  }

  /** Recreates the persisted accounts. Accounts without a registered module are kept but not loaded. */
  restore(): void {
    this.#handles = loadAccounts(this.#storage).flatMap((account) => {
      const module = this.#modules.get(account.type);
      if (!module) return [];
      const auth = module.restore(account);
      return [
        { account, auth, provider: module.createProvider(account, auth) },
      ];
    });
    this.#emitter.emit();
  }

  /** Current accounts. The array identity only changes when the list changes. */
  list = (): readonly AccountHandle[] => this.#handles;

  get(id: AccountId): AccountHandle | undefined {
    return this.#handles.find((handle) => handle.account.id === id);
  }

  /** Provider types that can be added. */
  availableModules(): readonly ProviderModule[] {
    return [...this.#modules.values()];
  }

  /**
   * Connects a new account interactively. Must be called from a user
   * gesture. Re-adding a known account replaces its session.
   */
  async add(type: ProviderType): Promise<AccountHandle> {
    const module = this.#modules.get(type);
    if (!module) throw new Error(`No provider module for "${type}"`);
    const { account, auth } = await module.connect();
    const handle: AccountHandle = {
      account,
      auth,
      provider: module.createProvider(account, auth),
    };
    const index = this.#handles.findIndex((h) => h.account.id === account.id);
    this.#handles =
      index === -1
        ? [...this.#handles, handle]
        : this.#handles.map((h, i) => (i === index ? handle : h));
    this.#persist();
    return handle;
  }

  /** Signs out (revoking the token where possible) and forgets the account. */
  async remove(id: AccountId): Promise<void> {
    const handle = this.get(id);
    if (!handle) return;
    this.#handles = this.#handles.filter((h) => h !== handle);
    this.#persist();
    this.#onRemove?.(id);
    try {
      await handle.auth.signOut();
    } catch {
      // The account is gone locally either way.
    }
  }

  subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  #persist() {
    saveAccounts(
      this.#storage,
      this.#handles.map((handle) => handle.account),
    );
    this.#emitter.emit();
  }
}
