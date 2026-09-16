/**
 * An outbound request throttle: a caller waits rather than being refused.
 *
 * This is the mirror image of `lib/api/rate-limit.ts`, and deliberately not the same thing.
 * That limiter guards *us* from a caller and answers yes or no; this one guards *them* from
 * us and answers "not yet, here is when". The SEC publishes ten requests a second for EDGAR
 * and blocks clients that exceed it, so a refusal we could retry on is no use — the only
 * correct behaviour is to slow down.
 *
 * Held as a log of send times rather than a counter per fixed window, for the reason the API
 * limiter gives: a fixed window lets a burst straddle the boundary and spend twice the budget
 * in two seconds. `now` and `sleep` are both injectable so the limit can be asserted against a
 * clock a test holds, rather than by a test that actually waits a second.
 */

export type Throttle = {
  /** Resolves when the caller may send. Callers are served in the order they arrive. */
  acquire: () => Promise<void>;
};

export type ThrottleOptions = {
  limit: number;
  windowMs: number;
  /** Injectable so a test can move time rather than let it pass. */
  now?: () => number;
  /** Injectable alongside `now`: a fake clock only advances if its sleeps advance it. */
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createThrottle({
  limit,
  windowMs,
  now = Date.now,
  sleep = wait,
}: ThrottleOptions): Throttle {
  const sent: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  async function reserve(): Promise<void> {
    for (;;) {
      const at = now();

      while (sent.length > 0 && sent[0]! <= at - windowMs) {
        sent.shift();
      }

      if (sent.length < limit) {
        sent.push(at);
        return;
      }

      // The budget frees up as the oldest send in the window ages out. Rounded up and floored
      // at a millisecond so a clock that only moves when we sleep always moves.
      await sleep(Math.max(1, Math.ceil(sent[0]! + windowMs - at)));
    }
  }

  return {
    acquire: () => {
      const turn = queue.then(reserve);

      // The queue must survive a caller that gives up or throws, or one rejection would strand
      // every request behind it.
      queue = turn.then(
        () => undefined,
        () => undefined,
      );

      return turn;
    },
  };
}

/**
 * EDGAR's published ceiling: ten requests a second, across every host the SEC serves. Exceeded
 * for long enough, the SEC blocks the client outright, which is why this is a hard constant
 * and not a tuning knob.
 */
export const EDGAR_REQUESTS_PER_SECOND = 10;
export const EDGAR_RATE_WINDOW_MS = 1_000;

export const createEdgarThrottle = (
  options: Pick<ThrottleOptions, "now" | "sleep"> = {},
): Throttle =>
  createThrottle({
    limit: EDGAR_REQUESTS_PER_SECOND,
    windowMs: EDGAR_RATE_WINDOW_MS,
    ...options,
  });
