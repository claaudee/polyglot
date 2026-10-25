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

