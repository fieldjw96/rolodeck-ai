import { ACCELERATOR_USER_AGENT } from "./accelerator-fetch";
import { ALLOW_ALL, parseRobots, type RobotsPolicy } from "./robots";
import { sameSite } from "./team-page";
import { createThrottle, type Throttle } from "./throttle";

/**
 * The one module under `lib/ingest` that fetches a company's own site, for the team-page
 * enrichment. See docs/adr/0016.
 *
 * Every other fetching module here reads a handful of sites chosen by hand, each with a note
 * on why its `robots.txt` allows us. This one reads whatever site a Company Profile names, so
 * the rules are enforced here rather than noted:
 *
 * - `robots.txt` is fetched per origin before anything else on it, and obeyed. A path it
 *   disallows is not requested. One that cannot be read at all (a 5xx, a timeout) means no
 *   request is made, as RFC 9309 says; one that does not exist (a 4xx) allows everything.
 * - Only the company's own site is fetched. Redirects are followed by hand so that one leading
 *   anywhere else, including to a social network or a directory, is refused rather than
 *   followed. `sameSite` is the rule, shared with the link-picking in `team-page.ts`.
 * - One request a second per host, and the same honest `User-Agent` the accelerator Source
 *   sends, naming this project.
 */

export const TEAM_PAGE_USER_AGENT = ACCELERATOR_USER_AGENT;

/** The token `robots.txt` groups are matched against: the first word of the User-Agent. */
export const ROBOTS_PRODUCT_TOKEN = "rolodeck-ai";

const REQUESTS_PER_HOST_PER_SECOND = 1;
const RATE_WINDOW_MS = 1_000;

/** Long enough for a slow site builder; short enough that one dead host does not stall a run. */
const REQUEST_TIMEOUT_MS = 15_000;

/** RFC 9309 asks for at least five; nothing legitimate needs more to reach a homepage. */
const MAX_REDIRECTS = 5;

/** A page larger than this is truncated; no team is stated past the first two megabytes. */
const MAX_PAGE_LENGTH = 2_000_000;

export type TeamPageResponse =
  | { readonly kind: "page"; readonly url: string; readonly html: string }
  | { readonly kind: "disallowed"; readonly url: string }
  | { readonly kind: "failed"; readonly url: string; readonly reason: string };

export type TeamSiteClient = {
  /**
   * One page of the site `url` is on. Never throws for anything the site did: a refusal, an
   * error status or an unreachable host is an answer, so one company cannot end a run.
   */
  readonly get: (url: string) => Promise<TeamPageResponse>;
};

export type TeamSiteClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so a test can build a throttle against a clock it holds. */
  readonly createThrottleFor?: (host: string) => Throttle;
};

type Hop =
  | {
      readonly kind: "response";
      readonly url: URL;
      readonly response: Response;
    }
  | { readonly kind: "disallowed" }
  | { readonly kind: "failed"; readonly reason: string };

/** Why a request may not be made: `robots.txt` refused it, or could not be read at all. */
type Refusal =
  | { readonly kind: "disallowed" }
  | { readonly kind: "failed"; readonly reason: string };

export function createTeamSiteClient({
  fetch = globalThis.fetch,
  createThrottleFor = () =>
    createThrottle({
      limit: REQUESTS_PER_HOST_PER_SECOND,
      windowMs: RATE_WINDOW_MS,
    }),
}: TeamSiteClientOptions = {}): TeamSiteClient {
  const throttles = new Map<string, Throttle>();
  const robots = new Map<string, Promise<RobotsPolicy | string>>();

  const throttleFor = (host: string): Throttle => {
    let throttle = throttles.get(host);
    if (throttle === undefined) {
      throttle = createThrottleFor(host);
      throttles.set(host, throttle);
    }
    return throttle;
  };

  /** One request, throttled, with no redirect followed. */
  const request = async (url: URL): Promise<Response> => {
    await throttleFor(url.host).acquire();
    return fetch(url, {
      headers: { "User-Agent": TEAM_PAGE_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  /**
   * Follows redirects only while they stay on `site`, asking `mayRequest` before each hop, so
   * a redirect to a disallowed path is refused just as a link to one would be.
   */
  const follow = async (
    start: URL,
    site: URL,
    mayRequest: (url: URL) => Promise<Refusal | null>,
  ): Promise<Hop> => {
    let url = start;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!sameSite(url, site)) {
        return {
          kind: "failed",
          reason: `redirected off the company's own site, to ${url.host}`,
        };
      }

      const refusal = await mayRequest(url);
      if (refusal !== null) {
        return refusal;
      }

      let response: Response;
      try {
        response = await request(url);
      } catch (error) {
        return {
          kind: "failed",
          reason: `could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        try {
          url = new URL(location, url);
        } catch {
          return { kind: "failed", reason: `redirected to ${location}` };
        }
        continue;
      }

      return { kind: "response", url, response };
    }

    return {
      kind: "failed",
      reason: `redirected more than ${MAX_REDIRECTS} times`,
    };
  };

  /**
   * The origin's `robots.txt`, fetched once per run. A string is why it could not be read,
   * which means nothing on that origin may be requested.
   */
  const robotsFor = (url: URL): Promise<RobotsPolicy | string> => {
    let policy = robots.get(url.origin);

    if (policy === undefined) {
      policy = (async () => {
        const hop = await follow(
          new URL("/robots.txt", url.origin),
          url,
          async () => null,
        );

        if (hop.kind !== "response") {
          return `robots.txt ${hop.kind === "failed" ? hop.reason : "was refused"}`;
        }

        const { status } = hop.response;
        if (hop.response.ok) {
          return parseRobots(await hop.response.text(), ROBOTS_PRODUCT_TOKEN);
        }
        // RFC 9309 2.3.1.3: a robots.txt that is unavailable allows everything.
        if (status >= 400 && status < 500) {
          return ALLOW_ALL;
        }
        // 2.3.1.4: one that is unreachable disallows everything.
        return `robots.txt answered ${status}`;
      })();
      robots.set(url.origin, policy);
    }

    return policy;
  };

  return {
    get: async (raw) => {
      let start: URL;
      try {
        start = new URL(raw);
      } catch {
        return { kind: "failed", url: raw, reason: "is not a URL" };
      }

      if (start.protocol !== "https:" && start.protocol !== "http:") {
        return { kind: "failed", url: raw, reason: "is not an http(s) URL" };
      }

      const hop = await follow(start, start, async (url) => {
        const policy = await robotsFor(url);

        if (typeof policy === "string") {
          return { kind: "failed", reason: policy };
        }
        return policy.allows(`${url.pathname}${url.search}`)
          ? null
          : { kind: "disallowed" };
      });

      if (hop.kind === "disallowed") {
        return { kind: "disallowed", url: raw };
      }
      if (hop.kind === "failed") {
        return { kind: "failed", url: raw, reason: hop.reason };
      }

      const { response, url } = hop;

      if (!response.ok) {
        return {
          kind: "failed",
          url: raw,
          reason: `answered ${response.status}`,
        };
      }

      const type = response.headers.get("content-type") ?? "";
      if (!/html/i.test(type)) {
        return {
          kind: "failed",
          url: raw,
          reason: `is not an HTML page (${type || "no content type"})`,
        };
      }

      const html = await response.text();
      return {
        kind: "page",
        url: url.toString(),
        html: html.slice(0, MAX_PAGE_LENGTH),
      };
    },
  };
}
