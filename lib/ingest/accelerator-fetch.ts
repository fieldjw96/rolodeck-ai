import { createThrottle, type Throttle } from "./throttle";

/**
 * The one module under `lib/ingest` that fetches an accelerator's batch page, mirroring the
 * split `edgar.ts` makes for the SEC Form D Source: parsing is offline and tested against
 * `db/fixtures/`, and touching the network is kept to this one file.
 *
 * An honest identity, not a browser's: every request carries a `User-Agent` that names this
 * project and where to find it, rather than pretending to be a visitor's browser. Neither of
 * this Source's two sites requires one — South Park Commons and AngelPad's `robots.txt` both
 * allow an unnamed client — but sending one anyway is what "honestly, at one request a second"
 * means in practice, not just in the rate limit below.
 *
 * Rate-limited to one request a second per host, per Ticket #50's Acceptance Criteria. Each
 * page here is fetched once per run, so the limit is never actually reached today; it exists so
 * a later batch page needing more than one request per site inherits the limit rather than
 * introducing it under pressure.
 */

export const ACCELERATOR_USER_AGENT =
  "rolodeck-ai (+https://github.com/fieldjw96/rolodeck-ai)";

const REQUESTS_PER_HOST_PER_SECOND = 1;
const RATE_WINDOW_MS = 1_000;

export type AcceleratorPage = {
  readonly sourceUrl: string;
  readonly html: string;
};

export type AcceleratorClient = {
  readonly get: (sourceUrl: string) => Promise<AcceleratorPage>;
};

export type AcceleratorClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so a test can build a throttle against a clock it holds. */
  readonly createThrottleFor?: (host: string) => Throttle;
};

export function createAcceleratorClient({
  fetch = globalThis.fetch,
  createThrottleFor = () =>
    createThrottle({
      limit: REQUESTS_PER_HOST_PER_SECOND,
      windowMs: RATE_WINDOW_MS,
    }),
}: AcceleratorClientOptions = {}): AcceleratorClient {
  const throttles = new Map<string, Throttle>();

  const throttleFor = (host: string): Throttle => {
    const existing = throttles.get(host);
    if (existing !== undefined) {
      return existing;
    }

    const throttle = createThrottleFor(host);
    throttles.set(host, throttle);
    return throttle;
  };

  return {
    get: async (sourceUrl) => {
      const host = new URL(sourceUrl).host;
      await throttleFor(host).acquire();

      const response = await fetch(sourceUrl, {
        headers: { "User-Agent": ACCELERATOR_USER_AGENT },
      });

      if (!response.ok) {
        throw new Error(`${sourceUrl} answered ${response.status}`);
      }

      return { sourceUrl, html: await response.text() };
    },
  };
}
