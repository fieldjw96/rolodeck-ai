# Ingest

## Company Sources

`lib/ingest/yc-company-page.ts` turns the HTML of one Y Combinator company page into a
validated `ProfileInput`, or into a rejection naming the single field that stopped it. It
parses and nothing else: it does not fetch, and it does not write. Discovering which companies
exist, and fetching them, is the `ycombinator` Source below. YC's directory listing at
`/companies` is client-rendered, so a plain GET of it holds no companies, and `robots.txt`
disallows `/companies?*`, every URL that pages through it. Neither applies to a company page
itself: a plain GET of `/companies/<slug>` returns the whole record, and YC publishes a sitemap
of every one.

Every field it produces carries provenance per field: the source URL, the capture date, and
whether the value was `scraped` or `enriched`. `stage` is the one `enriched` field, because a
company page states headcount but never a funding round. See `docs/adr/0007`.

Tests run offline against the pages in `db/fixtures/`, captured with `curl` and committed
byte-for-byte; `.gitattributes` marks them `-text` so no checkout rewrites their newlines.
To add one:

```
curl https://www.ycombinator.com/companies/<slug> -o db/fixtures/yc-<slug>.html
```

and write a `db/fixtures/yc-<slug>.meta.json` beside it recording `sourceUrl` and
`capturedAt`, which is where provenance comes from: the HTML does not carry either. Do not
hand-write a fixture. A parser tested against invented markup proves nothing about the real
page, which is the whole reason these are committed rather than generated.

`npm run ingest:ycombinator` runs the Source live, writing under the slug `ycombinator`. It reads
`https://www.ycombinator.com/companies/sitemap.xml` (`lib/ingest/yc-sitemap.ts`) for every
`/companies/<slug>` page and its `lastmod`, skipping the `/companies/industry/` listings, then
fetches at most 450 pages a run at one request a second through `lib/ingest/yc-fetch.ts`, the
only YC module that touches the network. Which 450 is deterministic: up to 200 pages YC changed
since yesterday, yesterday's before today's so a day's changes are all fetched by the next run
unless YC re-dated more than 200 at once, then a window of 250 of the whole sitemap in slug order
that advances each day, so daily runs walk all ~6200 companies in about 25 days rather than
re-fetching the same ones. A
page that fails to fetch or parse is named by URL and skipped; a sitemap that cannot be read, or
a run where every page failed, exits non-zero. `db/fixtures/yc-sitemap.xml` is the whole
sitemap as captured, and refreshes the same way:

```
curl https://www.ycombinator.com/companies/sitemap.xml -o db/fixtures/yc-sitemap.xml
```

`lib/ingest/show-hn.ts` reads the same way from Algolia's Hacker News Search API instead of a
scraped page: free, keyed, and JSON, so nothing here is scraped or parsed out of markup. A
Show HN post never states funding, so every record gets `stage: "pre-seed"` and `enriched`
provenance on it: an assumption about what Show HN mostly is, not a fact about any one
company, and one a later Source with a real funding round can overwrite. `sector` is read from
the post's own words with a keyword list, and a post whose words match nothing on it is
rejected rather than guessed at. A post linking to a GitHub repository, a video or a blog post
is not a company and is rejected the same way. Its fixtures are single-hit Algolia responses
under `db/fixtures/show-hn-*.json`, captured the same way:

```
curl "https://hn.algolia.com/api/v1/search?tags=story_<id>" -o db/fixtures/show-hn-<slug>.json
```

with a `db/fixtures/show-hn-<slug>.meta.json` beside it recording `query` and `capturedAt`.
`npm run source:show-hn` runs it live, against the real API and a real database, and is not
part of `npm test` or CI for that reason: it needs `ROLODECK_INGEST_DATABASE_URL` and `ROLODECK_OWNER_ID`,
and it exits non-zero if it inserts nothing.

## Writing what a Source parsed

Whatever a Source parses, it persists the same way: `persistProfiles` in `db/ingest.ts` is the
only write path into `profiles`, so a new Source Ticket is about fetching and parsing and
nothing else. It takes records, it never fetches, and returns how many it inserted, how many
it updated, and how many it rejected with the offending field named for each.

Every row it writes is owned by `ROLODECK_OWNER_ID`, and writes are idempotent on
`(owner_id, source, name_key)`: running a Source again updates the Profiles it wrote last time
rather than dealing the Deck a second card for the same company. `source` is a lowercase slug
naming the Source; `name_key` is the company name case-folded and whitespace-collapsed by
Postgres itself. See `docs/adr/0008` for why the key is that and not something else.

An update takes the incoming scrape's value and provenance for every field except one whose
stored provenance is `jack`: a value a human put there keeps both, however often the Source
runs again. The rule is decided inside the `on conflict` statement itself, not by reading the
row first.

The connection it writes through is its own: `getIngestDb()` in `db/ingest-connection.ts`, as
the `rolodeck_ingest` role, built from `ROLODECK_INGEST_DATABASE_URL` rather than the app's own
`DATABASE_URL`. The app's connection is a member of `authenticated` on purpose; ingest writes
rows owned by the account rather than by itself, so it needs a role that bypasses RLS on the
tables it writes, and nowhere else.

## Ingest's credential

`ROLODECK_INGEST_DATABASE_URL` logs in as `rolodeck_ingest`, a Postgres role created by
migration `0008_ingest_role`. See `docs/adr/0013` for why it exists and how it is scoped.

**What it may do:** select, insert and update `profiles`, `news_items`, `events` and
`event_attendances`, bypassing RLS on those four tables; delete from `event_attendances`, which
`persistEvents` replaces on every run; and call `ingest.kept_profile_ids`, which tells News which
Company Profiles are Kept.

**What it may not:** read or write `swipes`, `user_profiles`, or anything in the `auth` schema;
change a row's `id` or `owner_id`, so move nothing between accounts; delete or truncate a Company
Profile, an Event or News; create roles or databases; or become any other role.
`db/ingest-role.test.ts` asserts each of those against a real Postgres, and runs
`db/testing/ingest-role-check.sql` to refuse a role the migrations leave any broader. That check
runs in the test suite only: a grant made by hand in the Supabase SQL editor is caught by nothing.

**It is the only database credential that belongs in GitHub Actions repository secrets.**
Scheduled ingest runs there, so this one connection string may be an Actions secret.
`DATABASE_URL` and `SUPABASE_SECRET_KEY` may not: both reach every table. The one exception is
the deploy workflow's `production` environment, restricted to `main`, which ADR 0014 allows to
hold the migration and app connection strings; see "The workflow's secrets" in `docs/deploying.md`.

Setting it up, once the migration has been applied (by hand, never by a Run):

1. In the Supabase SQL editor, give the role a password:
   `alter role rolodeck_ingest with password '<a long random password>';`
2. Build the connection string from the pooler's, under Project Settings → Database, with
   `rolodeck_ingest.<project-ref>` as the user in place of `postgres.<project-ref>`. The pooler
   is what an IPv4-only host such as a GitHub Actions runner can reach; on a host with IPv6 the
   direct connection works too, with plain `rolodeck_ingest` as the user.
3. Put it in `.env.local` on the machine that runs ingest by hand and, for the scheduled workflows, in the
   repository's Actions secrets under the same name.

`getIngestDb()` refuses a connection string whose user is anything but `rolodeck_ingest`, or that
carries any query parameter but `sslmode`, so pasting the `postgres` one in its place fails on the
first line rather than quietly working. It then asks Postgres `select current_user`, and refuses
to write unless the answer is `rolodeck_ingest`.

## The Diary's events Sources

Events come from named Sources, each tested offline against a capture in `db/fixtures/`.
`techmeme-events` reads Techmeme's own iCalendar feed, which lists conferences and so states no
attendance. The rest are Luma calendars, where the Diary's Attendance comes from: one parser,
`parseLumaCalendar` in `lib/ingest/luma-calendar.ts`, reads the schema.org JSON-LD every Luma
calendar publishes, and the calendars read are the entries in `LUMA_CALENDARS`: `luma-bond-ai-sf`,
`luma-ai-events-sf`, `luma-silicon-valley-ai-hub` and `luma-frontier-tower-sf`. Each is its own
Source slug, so one calendar going stale cannot hide behind another; that module's header says why
each is read and states the rule for adding another. An Event's hosting organisations are its
stated Attendance, and nothing else is: a company named only in an Event's prose is not an
attendee.

`persistEvents` in `db/events.ts` is the one write path into `events` and `event_attendances`,
idempotent on `(owner_id, source, external_id)`, and it matches each attendee to Company Profiles
on `name_key`.

`npm run ingest:events` fetches every Source live and writes through
`ROLODECK_INGEST_DATABASE_URL`, like the Profile Sources. Run those first: an attendee only links
to a Company Profile already in the Deck, and the links fill in on the next run once it is. The
run prints, per Source, how many Events stated a hosting company and how many of those linked, so
a calendar naming companies nobody has Kept reads differently from one naming none at all.

## Scheduled runs

The seven Sources above are on a schedule in `.github/workflows/`, not run by hand. `ingest-sec-form-d.yml`,
`ingest-accelerator-batches.yml` (South Park Commons and AngelPad) and `ingest-show-hn.yml` run
weekly, Monday mornings UTC: company Sources change slowly, and EDGAR and Show HN are public
services `lib/ingest/throttle.ts` already asks this project to be polite to. `ingest-events.yml`
and `ingest-news.yml` run daily, since the Diary and News go stale by definition.
`ingest-ycombinator.yml` runs daily too, though YC changes no faster than the other company
Sources: each run fetches one bounded window of its sitemap, and the window only advances a day
at a time. All six are
GitHub-hosted runners calling one shared workflow, `ingest-run.yml`, which runs the same `npm
run <script>` documented above and authenticates with the `ROLODECK_INGEST_DATABASE_URL` Actions
secret from "Ingest's credential", never `SUPABASE_SECRET_KEY`. Each workflow's own
`concurrency` group serialises its runs, so a slow weekly run cannot overlap the next.

Trigger any of them by hand from the Actions tab (Actions → the workflow's name → **Run
workflow**) or with `gh workflow run ingest-sec-form-d.yml`; every one of them also carries a
`workflow_dispatch` trigger for exactly that, since the first thing anyone does with a broken
schedule is run it themselves.

A run's job summary reports what it inserted, updated and rejected, per Source, straight from
each script's own console output. A run that writes zero rows is a failure everywhere except
`ingest-news.yml`: every company-yielding Source and `ingest-events.yml` already exit non-zero
on an empty run (a rotted selector returns nothing and exits clean, which reads as "nothing new
today" at every layer above it unless the entry point itself refuses to call that success), but
News's own `newsRunFailed` (`lib/news/run.ts`) only trips when not one of its feeds could be
read. Until something is Kept there is nothing to match against, and a two-person startup can go a
month unreported after that, which is a quiet month and not a stale selector, so
`ingest-news.yml` does not treat zero articles as a failure. A feed that has changed shape is not
a quiet month either: it fails to parse, and is named in the job summary. A failed run opens or comments on a GitHub issue titled "Ingest failure: `<source>`", so
a Source down for a week produces one issue to read rather than seven to ignore.

## The run that never happened

A failed run is reported by the paragraph above. A run that never happened is not: it produces
no run, no failure and no issue, and a silently dead scraper reads exactly like a quiet week.
GitHub's scheduler is best-effort by its own documentation: delayed under load, occasionally
dropped, and disabled outright after a period of repository inactivity, which would stop every
Source at once. So `ingest-freshness.yml` runs daily at 16:10 UTC and asks of every Source
whether it has completed successfully since its own previous scheduled occurrence, plus six
hours of grace for that scheduling delay (`SCHEDULE_GRACE_MS` in `lib/ingest/freshness.ts`). One
that has not gets an issue titled "Ingest Source has not run: `<source>`", saying when it last
succeeded and when it should have, commented on rather than duplicated while it is still late,
the same one-issue-per-Source convention a failed run uses.

Which Sources are checked, and how often each is expected to run, come from the workflow files
themselves: a Source is a workflow in `.github/workflows/` that calls `ingest-run.yml`, and its
cadence is its own `schedule.cron`, read by `lib/ingest/workflow-schedules.ts` and turned into
scheduled occurrences by a real cron parser. Add a Source with a cron and it is watched; change
a cron and the check follows it. Nothing about a schedule is written down twice.

The check is itself a scheduled workflow, so whatever would silence every Source would silence
it too, and it cannot detect its own absence. It is partly self-healing, because the question
is "has it succeeded since its last occurrence", a check that misses a day reports the same
Source the next day with the gap intact rather than reset, but closing that properly needs a
watcher that does not depend on GitHub's scheduler at all.

## Filling a missing team from the company's own site

Y Combinator is the only Source that states a team, so Company Profiles from the other Sources
have an empty Team tab. `ingest-team-pages.yml` runs daily at 10:40 UTC and fills that gap from
the company's own site. It is not a Source: it creates no Company Profile, it only updates one
whose `founders` is null, and it never touches one whose Source stated a team. See
docs/adr/0016. It runs in three steps:

```
ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:team-pages:gather
# a model writes one JSON answer per company into $TEAM_PAGES_DIR/answers/
ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:team-pages:apply
```

The gather step takes up to `TEAM_PAGE_CANDIDATES_PER_RUN` Profiles with a website and no
founders, never-read first and then oldest attempt. For each one it reads `robots.txt` before
anything else on that host, and obeys it. It then reads the homepage and at most two same-site
pages that look like a team page, never a link off the site, at one request a second per host.
The model step is `anthropics/claude-code-action` with the existing `CLAUDE_CODE_OAUTH_TOKEN`.
It holds no database credential and can neither run a shell nor fetch anything. The apply step
passes every answer through a strict schema and drops any person whose full name the page text
does not state verbatim. It writes what survives attributed `enriched`, and records every
attempt in `founders_sought_at` so a site is not read again for 30 days.

The job summary gives the counts: candidates taken, skipped on `robots.txt`, pages not found,
companies whose page named nobody, people dropped for not appearing in the page, and profiles
updated. A run that updates nothing is a success, because most early companies have no team
page. A run where every candidate failed to fetch fails, and opens an "Ingest failure:
team-pages" issue. It is not a Source, so `ingest-freshness.yml` does not watch it.

## News

News is articles about the Company Profiles you Kept, read from the RSS feeds publishers offer
and shown on `/news`, grouped by company, newest first.

```
ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:news
```

fetches every feed in `NEWS_FEEDS` (`lib/news/feeds.ts`) once (today, Techmeme's `/feed.xml`),
scores every article in them against every Kept Company Profile, never one that is unswiped or
Passed, and stores each pair in `news_items` with a `confidence` from `scoreNewsMatch` in
`lib/news/match.ts` for how sure it is that the article is about that company and not a
namesake. The page shows only items at or above `NEWS_DISPLAY_THRESHOLD` in the same file; the
rest stay stored, so the threshold can be retuned without fetching anything again. Running it
twice adds no rows: articles are keyed on `(profile_id, url)`.

Beside the feeds, it searches a year of Hacker News for each Kept Company Profile through
Algolia's search API (`lib/news/history-search.ts`), so News finds what has been said about a
company and not only what published today. See `docs/adr/0018`.

Each feed is parsed through a Zod schema keyed by RSS's own element names, offline and tested
against its capture in `db/fixtures/`, so a feed that changes shape is rejected naming the feed
and the element, and one bad item costs that item. Requests go through
`lib/news/feed-fetch.ts` at one a second per host, with the same `User-Agent` as the other
Sources. The run prints each feed's outcome by name and exits non-zero only if every feed
failed. No key is needed. See `docs/adr/0010` and `docs/adr/0015`, which records what reading
feeds rather than searching costs in coverage. Adding a feed is one entry in `NEWS_FEEDS`, with
its `robots.txt` position, and a capture. Like every Source's script, this is on demand and not
part of `npm test` or CI.

## Measuring profile duplicates

A read-only script that measures how often the same company appears under multiple sources:

```
ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run measure:profile-duplicates
```

Reports the count of profiles that appear under more than one source, their percentage of the
total, and the worst offenders: companies appearing under the most sources. Matching uses the
same `name_key` the unique index on `profiles` uses, so case-insensitive and whitespace-insensitive
matching. Never writes to the database, only selects. See ADR 0008 for why `name_key` is the
identity rule.
