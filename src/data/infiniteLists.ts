import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  InfiniteQueryObserver,
  notifyManager,
  useIsRestoring,
  useQueryClient,
  type DefaultError,
  type DefaultedInfiniteQueryObserverOptions,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type InfiniteQueryObserverResult,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

/** Options of one list of {@link useInfiniteLists}. */
export type InfiniteListOptions<
  TPage,
  TParam,
  TKey extends QueryKey = QueryKey,
> = InfiniteQueryObserverOptions<
  TPage,
  DefaultError,
  InfiniteData<TPage, TParam>,
  TKey,
  TParam
>;

/** Result of one list of {@link useInfiniteLists}. */
export type InfiniteListResult<TPage, TParam> = InfiniteQueryObserverResult<
  InfiniteData<TPage, TParam>
>;

type Observer<TPage, TParam, TKey extends QueryKey> = InfiniteQueryObserver<
  TPage,
  DefaultError,
  InfiniteData<TPage, TParam>,
  TKey,
  TParam
>;

/**
 * Observes several infinite queries, like TanStack's `QueriesObserver` does
 * for plain ones: one observer per query hash, so a list coming or going
 * keeps the others' observers.
 */
class InfiniteListsObserver<TPage, TParam, TKey extends QueryKey> {
  readonly #client: QueryClient;
  readonly #observers = new Map<string, Observer<TPage, TParam, TKey>>();
  readonly #unsubscribes = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(client: QueryClient) {
    this.#client = client;
  }

  /** Changes with every result of every list (the external store's snapshot). */
  readonly version = (): number => this.#version;

  /** The observers of `options`, created as needed (subscribed later). */
  #observersFor(
    options: readonly InfiniteListOptions<TPage, TParam, TKey>[],
  ): Observer<TPage, TParam, TKey>[] {
    return options.map((option) => {
      const hash = this.#hashOf(option);
      const existing = this.#observers.get(hash);
      if (existing) return existing;
      const created: Observer<TPage, TParam, TKey> = new InfiniteQueryObserver(
        this.#client,
        option,
      );
      this.#observers.set(hash, created);
      return created;
    });
  }

  #hashOf(option: InfiniteListOptions<TPage, TParam, TKey>): string {
    return this.#client.defaultQueryOptions(option).queryHash;
  }

  /** The results to render now (like `getOptimisticResult` of one query). */
  results(
    options: readonly InfiniteListOptions<TPage, TParam, TKey>[],
  ): InfiniteListResult<TPage, TParam>[] {
    const observers = this.#observersFor(options);
    return observers.map((observer, index) => {
      const option = options[index];
      return option
        ? observer.getOptimisticResult(
            // What `useInfiniteQuery` passes too (the defaults keep the options' kind).
            this.#client.defaultQueryOptions(
              option,
            ) as DefaultedInfiniteQueryObserverOptions<
              TPage,
              DefaultError,
              InfiniteData<TPage, TParam>,
              TKey,
              TParam
            >,
          )
        : observer.getCurrentResult();
    });
  }

  /** Applies the options after rendering; drops lists no longer asked for. */
  setOptions(
    options: readonly InfiniteListOptions<TPage, TParam, TKey>[],
  ): void {
    const observers = this.#observersFor(options);
    observers.forEach((observer, index) => {
      const option = options[index];
      if (option) observer.setOptions(option);
    });
    const wanted = new Set(options.map((option) => this.#hashOf(option)));
    for (const [hash] of this.#observers) {
      if (wanted.has(hash)) continue;
      this.#unsubscribes.get(hash)?.();
      this.#unsubscribes.delete(hash);
      this.#observers.delete(hash);
    }
    if (this.#listeners.size > 0) this.#subscribeAll();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#subscribeAll();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      for (const unsubscribe of this.#unsubscribes.values()) unsubscribe();
      this.#unsubscribes.clear();
    };
  };

  #subscribeAll(): void {
    for (const [hash, observer] of this.#observers) {
      if (this.#unsubscribes.has(hash)) continue;
      this.#unsubscribes.set(
        hash,
        observer.subscribe(() => {
          this.#version += 1;
          for (const listener of this.#listeners) listener();
        }),
      );
      observer.updateResult();
    }
  }
}

/**
 * Several infinite queries at once, results in the order of `options`
 * (TanStack's `useQueries` only takes plain queries). The lists live in the
 * query cache under their own keys, so whatever patches those (optimistic
 * changes, live updates) shows here too.
 */
export function useInfiniteLists<TPage, TParam, TKey extends QueryKey>(
  options: readonly InfiniteListOptions<TPage, TParam, TKey>[],
): InfiniteListResult<TPage, TParam>[] {
  const client = useQueryClient();
  const isRestoring = useIsRestoring();
  const [observer] = useState(
    () => new InfiniteListsObserver<TPage, TParam, TKey>(client),
  );
  const defaulted = options.map(
    (option): InfiniteListOptions<TPage, TParam, TKey> => ({
      ...option,
      _optimisticResults: isRestoring ? "isRestoring" : "optimistic",
    }),
  );
  useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        isRestoring
          ? () => undefined
          : observer.subscribe(notifyManager.batchCalls(onChange)),
      [observer, isRestoring],
    ),
    observer.version,
    observer.version,
  );
  useEffect(() => {
    observer.setOptions(defaulted);
  }, [observer, defaulted]);
  return observer.results(defaulted);
}
