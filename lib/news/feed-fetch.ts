import { ACCELERATOR_USER_AGENT } from "../ingest/accelerator-fetch";
import { createThrottle, type Throttle } from "../ingest/throttle";

/**
 * The one module under `lib/news` that fetches: the feeds `NEWS_FEEDS` in `feeds.ts` names.
 * Parsing a feed is `feeds.ts` and is offline; this is the split `yc-fetch.ts`,
 * `accelerator-fetch.ts` and `edgar.ts` make for their own Sources.
 *
 * The same honest identity as the accelerator batch pages and Y Combinator — a `User-Agent`
 * naming this project and where to find it, not a browser's — and the same limit of one request
 * a second per host. A run makes one request per feed, so today the limit is only reached if two
 * feeds share a host; it exists so that a feed added on a host already read inherits it.
 */

const REQUESTS_PER_HOST_PER_SECOND = 1;
const RATE_WINDOW_MS = 1_000;

/**
 * A request that hangs would otherwise hold the run open until the Actions job times out hours
 * later; thirty seconds is far past any feed a publisher serves.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export type NewsFeedClient = {
  /** The response body as text, throttled and identified. Throws on any non-2xx. */
  readonly get: (url: string) => Promise<string>;
};

export type NewsFeedClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so a test can build a throttle against a clock it holds. */
  readonly createThrottleFor?: (host: string) => Throttle;
};

export function createNewsFeedClient({
  fetch = globalThis.fetch,
  createThrottleFor = () =>
    createThrottle({
      limit: REQUESTS_PER_HOST_PER_SECOND,
      windowMs: RATE_WINDOW_MS,
    }),
}: NewsFeedClientOptions = {}): NewsFeedClient {
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
    get: async (url) => {
      await throttleFor(new URL(url).host).acquire();

      const response = await fetch(url, {
        headers: { "User-Agent": ACCELERATOR_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      }

      return response.text();
    },
  };
}
