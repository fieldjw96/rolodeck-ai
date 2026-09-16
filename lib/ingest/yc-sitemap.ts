import { z } from "zod";

import { issueField } from "../zod/issues";
import { parseXml, type XmlDocument } from "./xml";

/**
 * Discovery for the Y Combinator Source: which company pages exist, read from the sitemap YC
 * publishes, and which of them one run fetches.
 *
 * Parsing only, like `yc-company-page.ts`: the input is a document a caller already has, so all
 * of this is tested offline against `db/fixtures/yc-sitemap.xml`. Fetching is `yc-fetch.ts`.
 *
 * The sitemap and not the `/companies` directory: the directory is client-rendered, and its
 * `robots.txt` disallows `/companies?*`, which is every URL that pages through it. A company page
 * at `/companies/<slug>` carries no query string and is allowed. See
 * `scripts/ingest-ycombinator.ts`.
 */

export const YC_ORIGIN = "https://www.ycombinator.com";

export type YcCompanyEntry = {
  /** The page to fetch, always `https://www.ycombinator.com/companies/<slug>`. */
  readonly url: string;
  readonly slug: string;
  /** The sitemap's own `lastmod`, as `YYYY-MM-DD`, or null when it gave none we could read. */
  readonly lastmod: string | null;
};

export type YcSitemap = {
  readonly companies: readonly YcCompanyEntry[];
  /**
   * Entries that are not a company page — today, the `/companies/industry/<slug>` listings — or
   * repeat one already listed.
   */
  readonly excluded: number;
  /** Company entries kept with `lastmod: null`, by URL, so a format change is visible. */
  readonly unusableLastmod: readonly string[];
};

/**
 * The shape the sitemap has to have. `<url>` is read as an array whether the document holds one
 * or six thousand, because `parseXml` returns a lone element as a record rather than a list of
 * one. `lastmod` is optional here — the industry entries have none — and judged per entry below,
 * since a company page whose date we cannot read is still a company page.
 */
const sitemapSchema = z.object({
  urlset: z.looseObject({
    url: z.preprocess(
      (value) => (Array.isArray(value) ? value : [value]),
      z.array(
        z.looseObject({
          loc: z.url({ protocol: /^https?$/ }),
          lastmod: z.string().optional(),
        }),
      ),
    ),
  }),
});

/**
 * The sitemap protocol allows a W3C datetime as well as a bare date. Every entry YC served on
 * 2026-09-16 was a bare date; a datetime is reduced to its UTC day rather than rejected.
 */
const lastmodSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

function readLastmod(raw: string | undefined): string | null {
  const parsed = lastmodSchema.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  return parsed.data.length === 10
    ? parsed.data
    : new Date(parsed.data).toISOString().slice(0, 10);
}

/**
 * The slug, when `loc` is a company page: YC's own origin, a path of `/companies/` and exactly
 * one non-empty segment, and no query string or fragment. Anything else — an industry listing,
 * a trailing slash, another host, a URL `robots.txt` disallows — is not something this Source
 * fetches.
 */
function companySlug(loc: string): string | undefined {
  const url = new URL(loc);

  if (url.origin !== YC_ORIGIN || url.search !== "" || url.hash !== "") {
    return undefined;
  }

  return /^\/companies\/([^/]+)$/.exec(url.pathname)?.[1];
}

/**
 * Reads the sitemap into its company pages. Throws, naming what is wrong, on a document that is
 * not XML, has no `<urlset>`, holds an entry with no usable `<loc>`, or lists no company page at
 * all: each of those is a sitemap that has changed shape, and the only honest result of reading
 * one is a failed run rather than a successful run of zero companies.
 */
export function parseYcSitemap(xml: string): YcSitemap {
  let root: XmlDocument;

  try {
    root = parseXml(xml);
  } catch (error) {
    throw new Error(
      `YC sitemap is not XML: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // Keyed by the root's own name, so a document whose root is anything but `<urlset>` — an HTML
  // error page, a `<sitemapindex>` — fails naming `urlset`.
  const parsed = sitemapSchema.safeParse({ [root.root]: root.content });

  if (!parsed.success) {
    // A failed safeParse always carries at least one issue.
    const issue = parsed.error.issues[0]!;
    throw new Error(
      `YC sitemap changed shape at ${issueField(issue)}: ${issue.message}`,
    );
  }

  const companies: YcCompanyEntry[] = [];
  const unusableLastmod: string[] = [];
  const seen = new Set<string>();
  let excluded = 0;

  for (const entry of parsed.data.urlset.url) {
    const slug = companySlug(entry.loc);

    // A slug listed twice is one page, and fetching it twice is a second request for nothing.
    if (slug === undefined || seen.has(slug)) {
      excluded += 1;
      continue;
    }

    seen.add(slug);

    const url = `${YC_ORIGIN}/companies/${slug}`;
    const lastmod = readLastmod(entry.lastmod);

    if (lastmod === null) {
      unusableLastmod.push(url);
    }

    companies.push({ url, slug, lastmod });
  }

  if (companies.length === 0) {
    throw new Error(
      `YC sitemap listed ${excluded} entries and not one was a company page at /companies/<slug>`,
    );
  }

  return { companies, excluded, unusableLastmod };
}

/**
 * How many company pages one run fetches at most.
 *
 * The sitemap listed 6226 company pages on 2026-09-16. At one request a second that is 6226
 * seconds, over 100 minutes, for a single run — not a shape a scheduled run should have, and
 * not a load to put on YC's site every day. 400 pages is under seven minutes at the same rate.
 */
export const MAX_PAGES_PER_RUN = 400;

/**
 * Of those, at most this many are pages YC changed since yesterday. On 2026-09-16 YC's own
 * `lastmod` put 88 pages on that day and 94 on the one before, so this covers an ordinary day's
 * changes — a new batch's companies among them — with room over.
 */
export const RECENT_PAGES_PER_RUN = 150;

/** The rest walk the whole sitemap in slug order, one window a day. */
export const ROTATION_PAGES_PER_RUN = MAX_PAGES_PER_RUN - RECENT_PAGES_PER_RUN;

/** How far back "changed recently" reaches: yesterday and today, so a daily run misses nothing. */
const RECENT_WINDOW_DAYS = 1;

const MS_PER_DAY = 86_400_000;

export type CompanyPageSelection = {
  readonly pages: readonly YcCompanyEntry[];
  /** How many of `pages` were picked because their `lastmod` is on or after `recentSince`. */
  readonly recent: number;
  readonly recentSince: string;
  /** Where in the slug-ordered list today's rotation window began, counting from zero. */
  readonly rotationStart: number;
};

function dayNumber(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);

  if (Number.isNaN(time)) {
    throw new Error(`the run's date must be YYYY-MM-DD, not ${date}`);
  }

  return Math.floor(time / MS_PER_DAY);
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Which company pages a run on `today` fetches. Deterministic: the same sitemap and the same day
 * always give the same pages, in the same order. Two lanes:
 *
 * 1. **Recently changed.** Every page whose `lastmod` is yesterday or today, newest first and then
 *    by slug, up to `RECENT_PAGES_PER_RUN`. That is where a newly listed company, or one whose
 *    page YC just updated, shows up the day after.
 * 2. **Rotation.** All company pages in slug order, and a window of `ROTATION_PAGES_PER_RUN` of
 *    them starting at `(days since 1970-01-01) × ROTATION_PAGES_PER_RUN`, modulo the number of
 *    pages, wrapping at the end. Successive days' windows are contiguous, so daily runs walk the
 *    whole sitemap — 6226 pages in 25 days — rather than re-fetching its head, and a re-run on the
 *    same day fetches the same window again, which ingest's idempotency makes harmless. A page
 *    already picked by the first lane is not fetched twice, so a run can fetch fewer than
 *    `MAX_PAGES_PER_RUN`.
 *
 * Progress lives in the date rather than in stored state: a missed day's window is skipped until
 * the rotation comes round again, and a company added or removed shifts the slug order by one.
 * Neither loses more than one cycle's coverage of a page.
 */
export function selectCompanyPages(
  companies: readonly YcCompanyEntry[],
  today: string,
): CompanyPageSelection {
  const day = dayNumber(today);
  const recentSince = new Date((day - RECENT_WINDOW_DAYS) * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);

  const recent = companies
    .filter(
      (company) => company.lastmod !== null && company.lastmod >= recentSince,
    )
    .sort(
      (a, b) => byString(b.lastmod!, a.lastmod!) || byString(a.slug, b.slug),
    )
    .slice(0, RECENT_PAGES_PER_RUN);

  const bySlug = [...companies].sort((a, b) => byString(a.slug, b.slug));
  const rotationStart =
    bySlug.length === 0 ? 0 : (day * ROTATION_PAGES_PER_RUN) % bySlug.length;

  const picked = new Set(recent.map((company) => company.slug));
  const rotation: YcCompanyEntry[] = [];

  for (
    let offset = 0;
    offset < Math.min(ROTATION_PAGES_PER_RUN, bySlug.length);
    offset += 1
  ) {
    const company = bySlug[(rotationStart + offset) % bySlug.length]!;

    if (!picked.has(company.slug)) {
      rotation.push(company);
    }
  }

  return {
    pages: [...recent, ...rotation],
    recent: recent.length,
    recentSince,
    rotationStart,
  };
}
