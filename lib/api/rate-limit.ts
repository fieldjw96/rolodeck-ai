/**
 * A sliding-window rate limiter, in memory, in this process.
 *
 * Held as a log of hit times per key rather than a counter per fixed window: a fixed window
 * lets a caller spend the whole budget in the last second of one window and the whole of the
 * next in the first second of the following one, which is twice the limit in two seconds.
 * A log of at most `limit` timestamps per key is small enough that the precision is free.
 *
 * The store is per server instance, which is a real limit and a deliberate one — see
 * docs/adr/0006 for why V1 does not reach for Redis.
 */

export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type RateLimiter = {
  /** Records a hit against `key` and says whether it is within the budget. */
  check: (key: string) => RateLimitDecision;
  /** Forgets every key. For tests: nothing in the app calls this. */
  reset: () => void;
};

export type RateLimiterOptions = {
  limit: number;
  windowMs: number;
  /** Injectable so a test can move time rather than wait for it. */
  now?: () => number;
};

export function createRateLimiter({
  limit,
  windowMs,
  now = Date.now,
}: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();
  let sweptAt = now();

  /** Drops the hits that have aged out of the window, and the key itself once it is empty. */
  function prune(key: string, at: number): number[] {
    const kept = (hits.get(key) ?? []).filter((hit) => hit > at - windowMs);

    if (kept.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, kept);
    }

    return kept;
  }

  /**
   * Pruning only the key being checked would leave every key that is never seen again in the
   * map for the life of the process, so once per window every key gets the same treatment.
   */
  function sweep(at: number): void {
    if (at - sweptAt < windowMs) {
      return;
    }

    sweptAt = at;

    for (const key of [...hits.keys()]) {
      prune(key, at);
    }
  }

  return {
    check: (key) => {
      const at = now();

      sweep(at);

      const recent = prune(key, at);

      if (recent.length >= limit) {
        // The budget frees up as the oldest hit in the window ages out, and never in under a
        // second: `Retry-After` is whole seconds, and rounding down would invite a retry that
        // is refused again.
        const oldest = recent[0]!;

        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + windowMs - at) / 1000),
          ),
        };
      }

      hits.set(key, [...recent, at]);

      return { allowed: true, remaining: limit - recent.length - 1 };
    },
    reset: () => {
      hits.clear();
      sweptAt = now();
    },
  };
}

/** Sixty requests a minute per account, as the Ticket asks. */
export const API_RATE_LIMIT = 60;
export const API_RATE_WINDOW_MS = 60_000;

/**
 * The budget every route handler under `/api` spends from, shared across the endpoints and
 * keyed by the signed-in user. Shared rather than per-endpoint because the thing being
 * protected — Supabase Auth on one side, Postgres on the other — is shared too, and a caller
 * that can spend 60 on each of three endpoints has a budget of 180.
 */
export const apiRateLimiter = createRateLimiter({
  limit: API_RATE_LIMIT,
  windowMs: API_RATE_WINDOW_MS,
});
