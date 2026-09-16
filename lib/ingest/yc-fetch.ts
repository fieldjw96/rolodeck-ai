import { ACCELERATOR_USER_AGENT } from "./accelerator-fetch";
import { createThrottle, type Throttle } from "./throttle";
import { YC_ORIGIN } from "./yc-sitemap";

/**
 * The one module under `lib/ingest` that fetches from Y Combinator: its published sitemap of
 * company pages, and the pages themselves. Discovery is `yc-sitemap.ts`, parsing a page is
 * `yc-company-page.ts`, and both are offline; this is the split `accelerator-fetch.ts` and
 * `edgar.ts` make for their own Sources.
 *
 * The same honest identity as the accelerator batch pages — YC is an accelerator, and the
 * convention is this project's, not a site's — and the same limit of one request a second per
 * host. Unlike those pages, a YC run makes hundreds of requests to one host, so here the limit is
 * what actually paces the run.
 */

export const YC_SITEMAP_URL = `${YC_ORIGIN}/companies/sitemap.xml`;

const REQUESTS_PER_HOST_PER_SECOND = 1;
const RATE_WINDOW_MS = 1_000;

/**
 * A request that hangs would otherwise hold the run open until the Actions job times out hours
 * later; thirty seconds is far past any company page YC serves.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export type YcClient = {
  /** The response body as text, throttled and identified. Throws on any non-2xx. */
  readonly get: (url: string) => Promise<string>;
};

export type YcClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so a test can build a throttle against a clock it holds. */
  readonly createThrottleFor?: (host: string) => Throttle;
};

export function createYcClient({
  fetch = globalThis.fetch,
  createThrottleFor = () =>
    createThrottle({
      limit: REQUESTS_PER_HOST_PER_SECOND,
      windowMs: RATE_WINDOW_MS,
    }),
}: YcClientOptions = {}): YcClient {
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
      const parsed = new URL(url);

      // YC's robots.txt disallows `/companies?*`, which is how its directory pages. Nothing this
      // Source fetches needs a query string, so none is ever sent, whoever the caller is.
      if (parsed.search !== "") {
        throw new Error(
          `${url} carries a query string, which this Source never requests: YC's robots.txt disallows /companies?*`,
        );
      }

      await throttleFor(parsed.host).acquire();

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
