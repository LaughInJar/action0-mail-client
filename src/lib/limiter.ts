/** Runs a task once a slot is free. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Creates a limiter that runs at most `maxConcurrent` tasks at the same time. */
export function createLimiter(maxConcurrent: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active--;
    queue.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
