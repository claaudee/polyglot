/** Runs `run` up to `attempts` times while `retryable(error)` holds; rethrows the last error. */
export const retry = async <T>(
  attempts: number,
  run: (attempt: number) => Promise<T>,
  retryable: (error: unknown) => boolean = () => true
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
    }
  }
};

/** Unbounded push queue read as an endless async iterable, e.g. a streaming-input feed. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) yield this.items.length > 0 ? this.items.shift()! : await new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep input order. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await fn(items[index]!, index);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
};
