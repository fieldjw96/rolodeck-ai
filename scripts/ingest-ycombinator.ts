import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { createYcClient } from "../lib/ingest/yc-fetch";
import {
  runYcIngest,
  summariseYcRun,
  ycRunFailure,
} from "../lib/ingest/yc-run";

/**
 * The operator entry point for the Y Combinator Source. Everything worth testing lives in
 * `lib/ingest/`; this file is argv in, stdout out, and an exit code — the same split
 * `scripts/ingest-sec-form-d.ts` makes.
 *
 * On demand only. It is not in `npm test` and not in CI: it makes real requests to a live site
 * and writes real rows as the ingest role.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:ycombinator
 *
 * `robots.txt`, checked on 2026-09-16 before the sitemap fixture was captured:
 *
 * - Y Combinator: `Allow: /` for every client, with `Disallow: /verify/*`, `/library?*` (bar
 *   one `categories` form) and `/companies?*`. A company page at `/companies/<slug>` carries no
 *   query string and is allowed, as is `/companies/sitemap.xml`.
 * - `Disallow: /companies?*` is why discovery reads the sitemap and not the directory listing.
 *   The listing at `/companies` is client-rendered, so a plain GET of it holds no companies, and
 *   every URL that pages or filters it — `/companies?page=...`, `/companies?batch=...` — is
 *   disallowed. This Source never requests one: `lib/ingest/yc-fetch.ts` refuses any URL with a
 *   query string, and it does not call the search index or internal API the listing page uses.
 * - `https://www.ycombinator.com/sitemap.xml` names the company sitemap as
 *   `/companies/sitemap`, which 404s; `/companies/sitemap.xml` is the one that answers.
 *
 * One run fetches at most `MAX_PAGES_PER_RUN` company pages, picked deterministically by
 * `selectCompanyPages` in `lib/ingest/yc-sitemap.ts`: the pages YC changed since yesterday, and
 * one day's window of a rotation through the whole sitemap. It is scheduled daily so the rotation
 * advances a window a day.
 *
 * Known limitation: a company already present under `sec-form-d`, `show-hn`,
 * `south-park-commons` or `angelpad` is not matched here, and becomes a second card in the Deck.
 * That is the cost docs/adr/0008 accepts and names; entity resolution is a later Ticket's.
 *
 * Exits non-zero when the sitemap cannot be read, when every company page picked failed, or when
 * the run wrote nothing.
 */
async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  const run = await runYcIngest(createYcClient(), await getIngestDb(), today);

  console.log(summariseYcRun(run));

  const failure = ycRunFailure(run);

  if (failure !== undefined) {
    throw new Error(failure);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
