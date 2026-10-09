import { errorMessage, type Logger } from '../util/log.ts';

/** Rate limits, overload and the like: worth a retry. Auth or validation errors are not. */
export function isTransient(err: unknown): boolean {
  const e = (err ?? {}) as { isRetryable?: boolean; statusCode?: number; message?: string };
  if (e.isRetryable === true) return true;
  if (typeof e.statusCode === 'number') return e.statusCode === 408 || e.statusCode === 429 || e.statusCode >= 500;
  return /rate.?limit|overloaded|temporar|timed? ?out|unavailable/i.test(e.message ?? '');
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface RetryPolicy {
  retries: number;
  baseMs: number;
}

export const backoffMs = (policy: RetryPolicy, attempt: number) => policy.baseMs * 2 ** (attempt - 1);

/** Runs a side-effect-free model call, retrying transient failures with exponential backoff. */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: RetryPolicy & { signal?: AbortSignal; log: Logger; what: string },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > opts.retries || opts.signal?.aborted || !isTransient(err)) throw err;
      opts.log.warn(`${opts.what} failed transiently; retrying`, { attempt, error: errorMessage(err) });
      await pause(backoffMs(opts, attempt), opts.signal);
    }
  }
}
