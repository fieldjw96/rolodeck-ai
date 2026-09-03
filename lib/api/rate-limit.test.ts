// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  API_RATE_LIMIT,
  API_RATE_WINDOW_MS,
  createRateLimiter,
  type RateLimiter,
} from "./rate-limit";

const WINDOW = 60_000;

/** A limiter whose clock the test holds, so a window can pass without one going by. */
function limiterAt(start: number, limit = 3) {
  let time = start;
  const limiter = createRateLimiter({
    limit,
    windowMs: WINDOW,
    now: () => time,
  });

  return {
    limiter,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const spend = (limiter: RateLimiter, key: string, times: number) =>
  Array.from({ length: times }, () => limiter.check(key));

describe("the rate limiter", () => {
  it("allows exactly the limit and then refuses", () => {
    const { limiter } = limiterAt(1_000);

    expect(spend(limiter, "jack", 3).map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.check("jack")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("counts down what is left of the budget", () => {
    const { limiter } = limiterAt(1_000);

    expect(spend(limiter, "jack", 3)).toEqual([
      { allowed: true, remaining: 2 },
      { allowed: true, remaining: 1 },
      { allowed: true, remaining: 0 },
    ]);
  });

  it("keeps one key's spending off another's budget", () => {
    const { limiter } = limiterAt(1_000);

    spend(limiter, "jack", 3);

    expect(limiter.check("somebody-else").allowed).toBe(true);
  });

  it("frees the budget as the oldest hit ages out, not all at once", () => {
    const { limiter, advance } = limiterAt(1_000);

    limiter.check("jack");
    advance(30_000);
    spend(limiter, "jack", 2);

    expect(limiter.check("jack").allowed).toBe(false);

    // The first hit ages out here; the two made 30s later have not.
    advance(WINDOW - 30_000 + 1);

    expect(limiter.check("jack").allowed).toBe(true);
    expect(limiter.check("jack").allowed).toBe(false);
  });

  it("says how long until the budget frees up, rounded up to a whole second", () => {
    const { limiter, advance } = limiterAt(1_000);

    spend(limiter, "jack", 3);
    advance(59_200);

    // 800ms of the window left, which is a `Retry-After` of 1 rather than 0.
    expect(limiter.check("jack")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("refuses a burst that straddles two windows, which a fixed window would allow", () => {
    const { limiter, advance } = limiterAt(1_000);

    // The whole budget at the end of one nominal minute...
    advance(59_000);
    spend(limiter, "jack", 3);

    // ...and the next request two seconds later, well inside a sliding window.
    advance(2_000);

    expect(limiter.check("jack").allowed).toBe(false);
  });

  it("forgets a key once its hits have aged out, rather than growing for ever", () => {
    const { limiter, advance } = limiterAt(1_000);

    spend(limiter, "gone", 3);
    advance(WINDOW + 1);

    // A different key is what triggers the sweep: `gone` is never asked about again.
    limiter.check("jack");

    expect(spend(limiter, "gone", 3).map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("gives every key a clean budget after a reset", () => {
    const { limiter } = limiterAt(1_000);

    spend(limiter, "jack", 3);
    limiter.reset();

    expect(limiter.check("jack").allowed).toBe(true);
  });
});

describe("the budget the API is configured with", () => {
  it("is the 60 requests a minute the Ticket asks for", () => {
    expect(API_RATE_LIMIT).toBe(60);
    expect(API_RATE_WINDOW_MS).toBe(60_000);
  });
});
