// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createEdgarThrottle,
  createThrottle,
  EDGAR_RATE_WINDOW_MS,
  EDGAR_REQUESTS_PER_SECOND,
} from "./throttle";

/**
 * A clock the test holds. `sleep` advances it and yields, which is the whole trick: the
 * throttle's only way to let time pass is to sleep, so a suite that asserts a rate limit runs
 * in microseconds and never waits a real second for a limit measured in seconds.
 */
function fakeClock(start = 0) {
  let time = start;

  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      await Promise.resolve();
    },
    get time() {
      return time;
    },
  };
}

/** Takes `count` turns in order, recording the fake time each was allowed to send at. */
async function send(
  throttle: { acquire: () => Promise<void> },
  now: () => number,
  count: number,
): Promise<number[]> {
  const at: number[] = [];

  await Promise.all(
    Array.from({ length: count }, async () => {
      await throttle.acquire();
      at.push(now());
    }),
  );

  return at;
}

/** The largest number of sends falling inside any one window. */
function busiestWindow(at: readonly number[], windowMs: number): number {
  return Math.max(
    ...at.map(
      (start) =>
        at.filter((other) => other >= start && other < start + windowMs).length,
    ),
  );
}

describe("the EDGAR throttle", () => {
  it("never sends more than ten in any one second", async () => {
    const clock = fakeClock();
    const throttle = createEdgarThrottle(clock);

    const at = await send(throttle, clock.now, 25);

    expect(at).toHaveLength(25);
    expect(busiestWindow(at, EDGAR_RATE_WINDOW_MS)).toBe(
      EDGAR_REQUESTS_PER_SECOND,
    );
  });

  it("spends the whole budget before waiting at all", async () => {
    const clock = fakeClock(1_000);
    const throttle = createEdgarThrottle(clock);

    const at = await send(throttle, clock.now, EDGAR_REQUESTS_PER_SECOND);

    expect(at).toEqual(Array(EDGAR_REQUESTS_PER_SECOND).fill(1_000));
    expect(clock.time).toBe(1_000);
  });

  it("waits exactly until the oldest send has aged out, and no longer", async () => {
    const clock = fakeClock(1_000);
    const throttle = createEdgarThrottle(clock);

    await send(throttle, clock.now, EDGAR_REQUESTS_PER_SECOND);
    await throttle.acquire();

    expect(clock.time).toBe(1_000 + EDGAR_RATE_WINDOW_MS);
  });

  it("does not carry unspent budget forward across a quiet spell", async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ limit: 2, windowMs: 100, ...clock });

    await throttle.acquire();
    await clock.sleep(10_000);

    // A fixed-window counter would now allow a whole fresh window's worth on top of the
    // send above; a log of send times simply forgets the one that has aged out.
    const at = await send(throttle, clock.now, 3);

    expect(at).toEqual([10_000, 10_000, 10_100]);
  });

  it("keeps serving callers after one of them fails", async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ limit: 1, windowMs: 100, ...clock });

    await expect(
      throttle.acquire().then(() => {
        throw new Error("the caller blew up");
      }),
    ).rejects.toThrow("the caller blew up");

    await throttle.acquire();

    expect(clock.time).toBe(100);
  });

  it("serves callers in the order they arrived", async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ limit: 1, windowMs: 10, ...clock });
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (index) => {
        await throttle.acquire();
        order.push(index);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
  });
});
