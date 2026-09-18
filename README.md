# rolodeck-ai

A fully AI-authored swipeable deck of Bay Area startup profiles, deployed at
https://rolodeck-ai.vercel.app. It began as a stress test of an unattended dispatcher and is
now the product; every line of it is written by Runs.

The supervisor is [`foreman`](https://github.com/fieldjw96/foreman), which replaced
`agent-harness` on 2026-09-10. Most pull requests here merge themselves once the checks are
green, the review Gate has approved, and the branch is current; the exceptions are in
`.github/CODEOWNERS` and the reasoning is in ADR 0012.

See `CLAUDE.md` for the rules an agent works under here, `CONTEXT.md` for vocabulary, and
`docs/adr/` for why the merge and data-sourcing decisions were made this way.

## Prerequisites

- Node 22.x and npm. `package.json`'s `engines.node` pins the same version CI and Vercel
  build with.
- A Supabase project: its URL, publishable key, secret key, and its pooled Postgres
  connection string, all from the project's dashboard, plus a password you set for the
  ingest role — see "Ingest's credential" below. See `.env.example` for exactly which values
  and where each one lives.
- Nothing else. `npm run test` and `npm run test:e2e` both run against in-process
  stand-ins — a stub Postgres and a stub Supabase Auth backend — so no database or Supabase
  project needs to exist just to run the suite.

## Running it locally

Copy `.env.example` to `.env.local` and fill in the Supabase values, then `npm run dev`.

Every route is behind Supabase Auth except `/login`. There is no sign-up: V1 has one account,
and it is created by

```
npm run account:provision -- jack@example.com
```

which needs `SUPABASE_SECRET_KEY`, generates the password, prints it once, and refuses to run
if the project already has an account. See `docs/adr/0004` for why the gate is written in two
places, and why the auth tests run against an in-process stub by default.

To run those tests against a real Supabase project instead of the stub, set `SUPABASE_TEST_URL`,
`SUPABASE_TEST_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`. Use a scratch project: the tests
create and delete users through the Admin API.

## Running the test suite

- `npm run typecheck`, `npm run lint` and `npm run format:check` need no environment at all.
- `npm run test` runs Vitest — unit and integration — against an in-process Postgres and the
  stub Supabase Auth backend from the section above. Nothing needs to be running first.
- `npm run test:e2e` runs Playwright against that same stub; the suite builds and starts its
  own server, so it needs no `.env.local` either.
- `npm run test:e2e:db` runs Playwright's swipe-flow suite (Ticket #13) against a real
  Postgres instead. Point `DATABASE_URL` at a scratch database, apply
  `db/testing/supabase-shim.sql` to it first — same as `npm run db:migrate`, see "Database"
  below — then run the command.
- `npm run build` followed by `npm run check:bundle-secrets` confirms nothing server-only
  leaked into the client bundle; CI runs this pair on every pull request.

## Smoke testing a deployment

```
ROLODECK_SMOKE_EMAIL=... ROLODECK_SMOKE_PASSWORD=... npm run smoke
npm run smoke -- http://localhost:3000
```

Signs in to a running deployment and checks that the login page renders, that signing in
lands on the Deck, that the Deck deals a Company Profile out of Postgres, and that the
Watchlist renders. Exits non-zero if any of that fails.

**It writes nothing.** It never Keeps or Passes. Destructive testing belongs in
`npm run test:e2e:db`, which runs against a throwaway Postgres and a throwaway user; this
one runs against the real deployment and the real single account, so a Keep here would put a
Company Profile on Jack's Watchlist that he never chose.

It exists for the class of failure a diff cannot show. Both real bugs in the first
deployment were of that kind: a UTF-8 BOM prepended to an environment variable, so every
sign-in failed against a URL that looked correct, and a database host that resolves locally
but not from a serverless function. Tests and review passed both.

## Deploying

This is a standard Next.js App Router project. `vercel.json` pins the install command, the
build command (`npm run build`) and the output directory (`.next`); `package.json`'s
`engines.node` pins the Node version, so Vercel builds with the same one CI does.

**Merging to `main` is deploying.** `.github/workflows/deploy.yml` runs on every push to `main`
and on nothing else, and stops at the first step that fails:

1. Installs dependencies, the Vercel CLI among them, and the smoke test's browser, with no
   secret in the environment. Then it checks the commit is still the tip of `origin/main`,
   checks every secret below is present and that both database URLs are Supabase pooler URLs,
   and checks the Vercel project is reachable. Nothing in production has changed yet, so a
   missing secret costs nothing.
2. Sets the three variables the running app reads in Vercel's Production environment, after
   failing if Vercel holds `SUPABASE_SECRET_KEY` or `SUPABASE_DB_URL`, and checks the two
   browser-visible ones round-trip exactly. Vercel applies them to new deployments only, so
   this changes nothing already serving.
3. Applies pending migrations with `npm run db:migrate`. Production is a real Supabase
   project, so `db/testing/supabase-shim.sql` is never applied to it.
4. Checks `origin/main` has not moved, then deploys with `vercel deploy --prod`.
5. Runs `npm run smoke` against https://rolodeck-ai.vercel.app.

Re-running an old Deploy run fails at the tip-of-`main` check rather than rolling production
back: a re-run keeps its original commit, and drizzle, which applies only newer migrations,
would not stop it. To redeploy, re-run the latest one.

The CLI is the `vercel` devDependency, pinned exactly and run as `./node_modules/.bin/vercel`,
never `npx vercel@...`, whose unlocked dependencies would install inside a step holding the
token. Its dependency tree carried high and critical advisories, mostly in the builders and
dev server a remote `vercel deploy` never runs locally, and `package.json`'s `overrides` lift
each to a patched release so `npm audit` stays clean. Every one stays within its major except
undici, 5 to 6, which the CLI itself loads only when an HTTP proxy is configured.

A failed migration means no deploy. Any failure, or a cancelled run such as one that hits the
job's 30-minute timeout, opens an issue titled
`Deploy to production failed: <step>` linking the run; while that issue is open, a repeat
failure comments on it rather than opening a second. See `docs/adr/0014` for why migrations run
here, unattended, and not when the app boots.

Vercel's own Git integration is not connected, and must stay that way: it deploys the moment a
commit lands, which would race the migration. `vercel.json` sets `git.deploymentEnabled` to
`false` so that reconnecting it by mistake still would not deploy on push.
`scripts/deploy-workflow.test.ts` asserts that, the trigger, the step order and the variables
below.

### The workflow's secrets

Set these by hand as secrets of a GitHub environment named `production` (Settings →
Environments), with its deployment branches limited to `main`. That restriction is what keeps
them from a job on any other branch, including a workflow a pull request adds of its own;
repository-level secrets would not be withheld from it.

| Secret                                 | What it is                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`               | The privileged `postgres` connection migrations run as, through the session-mode pooler (`pooler.supabase.com`, port 5432). Not ingest's. |
| `SUPABASE_POOLER_URL`                  | The pooler URL the deployed app connects with; set in Vercel as `DATABASE_URL`.                                                           |
| `NEXT_PUBLIC_SUPABASE_URL`             | The project URL, as in `.env.example`.                                                                                                    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable key, as in `.env.example`.                                                                                                |
| `VERCEL_TOKEN`                         | A Vercel access token for the account that owns the `rolodeck-ai` project.                                                                |
| `ROLODECK_SMOKE_EMAIL`                 | The account `npm run smoke` signs in as.                                                                                                  |
| `ROLODECK_SMOKE_PASSWORD`              | Its password.                                                                                                                             |

Both database URLs must be pooler URLs, and the workflow refuses anything else before it
touches production. Supabase's direct host `db.<ref>.supabase.co` is IPv6-only, and neither
GitHub's runners nor Vercel's functions have IPv6 outbound.

`SUPABASE_SECRET_KEY` is deliberately not among them, and neither is
`ROLODECK_INGEST_DATABASE_URL`: the running app reads neither, so neither belongs in Vercel
either. The secret key stays on the server laptop for `npm run account:provision`; the database
URL is ingest's. `ROLODECK_OWNER_ID` comes from running
`npm run account:provision` once, against the real project.

Two of these are database credentials, and CLAUDE.md otherwise allows only ingest's in GitHub
Actions. ADR 0014 is the ADR that widens that rule, and it widens it this far and no further:
`MIGRATION_DATABASE_URL` and `SUPABASE_POOLER_URL`, as secrets of the `production` environment
only, never as repository secrets. `scripts/deploy-workflow.test.ts` fails if the workflow names
any secret beyond the ones in this table.

`SUPABASE_DB_URL` is the name ADR 0013 retired; nothing reads it any more. The workflow no
longer sets it, and fails, before migrating, if Vercel's Production environment still holds it
or `SUPABASE_SECRET_KEY`. Remove either with `vercel env rm <name> production`, and keep
`deploy-rolodeck.ps1` from setting `SUPABASE_DB_URL` again.

The `build-with-documented-env` job in CI keeps `.env.example` honest: it builds with only
`.env.example`'s variables set, in a job with nothing else in its environment, so a variable
the app secretly needed but nobody documented fails there instead of in production.

### Break glass: deploying by hand

`C:\agent-runs\deploy-rolodeck.ps1` on the server laptop deploys the current `origin/main`
from there, reading `C:\agent-secrets\rolodeck-ai.env`. Use it when GitHub Actions is down, or
when the workflow itself is what broke:

```
powershell -ExecutionPolicy Bypass -File C:\agent-runs\deploy-rolodeck.ps1
```

It sets the app's variables and deploys, but it does **not** apply migrations, and it does not
check that `SUPABASE_DB_URL` is absent from Vercel, as the workflow does. If `main`
has any production lacks, run `npm run db:migrate` against production first. Its comments
record the two failures the workflow is built not to repeat: a UTF-8 BOM that PowerShell
prepends to a piped value, and the IPv6-only direct database host.

## The Profiles API

Profiles reach the browser only through these route handlers, never by querying Postgres from
a client. All of them require a session and answer `401` without one.

| Endpoint                      | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `GET /api/profiles`           | One page of the Deck, newest first                               |
| `POST /api/profiles/:id/keep` | Records a Keep, which drops the Profile from later pages         |
| `POST /api/profiles/:id/pass` | Records a Pass, which does the same without deleting the Profile |
| `GET /api/news`               | News about Kept Profiles, grouped by company, newest first       |

`GET /api/profiles` takes `?limit=` (1 to 50, default 20) and `?cursor=`, and answers with the
Profiles plus a `next_cursor`, which is `null` on the last page. The cursor is opaque: hand back
the one the previous page issued. Anything else, including a limit outside its range, gets a
`422` naming the field it objected to.

`GET /api/news` takes nothing, and answers with `companies`: each Kept Profile that has News at
or above the display threshold, its articles newest first, each carrying its `confidence`.

All of them share one budget of 60 requests a minute per account. Spend it and they answer
`429` with a `Retry-After` in seconds until the oldest request in the window ages out.

## Security

Every response through the Proxy carries a `Content-Security-Policy` — nonce-based, so no
inline script runs unless Next put it there — plus `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`. They are set in
`lib/http/security-headers.ts` and applied by the gate. See `docs/adr/0006`, which also explains
why the rate limit is where it is and what it does not cover.

CI runs `npm audit --audit-level=high` on every pull request, and `npm run check:bundle-secrets`
after the build, which greps the client output for the names and values of anything that must
stay on the server. Run that one yourself after `npm run build`.

## Ingest

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
byte-for-byte — `.gitattributes` marks them `-text` so no checkout rewrites their newlines.
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
scraped page — free, keyed, and JSON, so nothing here is scraped or parsed out of markup. A
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

### Writing what a Source parsed

Whatever a Source parses, it persists the same way: `persistProfiles` in `db/ingest.ts` is the
only write path into `profiles`, so a new Source Ticket is about fetching and parsing and
nothing else. It takes records — it never fetches — and returns how many it inserted, how many
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
rows owned by the account rather than by itself, so it needs a role that bypasses RLS — on the
tables it writes, and nowhere else.

### Ingest's credential

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
hold the migration and app connection strings; see "The workflow's secrets" above.

Setting it up, once the migration has been applied — by hand, never by a Run:

1. In the Supabase SQL editor, give the role a password:
   `alter role rolodeck_ingest with password '<a long random password>';`
2. Build the connection string from the pooler's, under Project Settings → Database, with
   `rolodeck_ingest.<project-ref>` as the user in place of `postgres.<project-ref>`. The pooler
   is what an IPv4-only host such as a GitHub Actions runner can reach; on a host with IPv6 the
   direct connection works too, with plain `rolodeck_ingest` as the user.
3. Put it in `.env.local` on the server laptop and, for the scheduled workflows, in the
   repository's Actions secrets under the same name.

`getIngestDb()` refuses a connection string whose user is anything but `rolodeck_ingest`, or that
carries any query parameter but `sslmode`, so pasting the `postgres` one in its place fails on the
first line rather than quietly working. It then asks Postgres `select current_user`, and refuses
to write unless the answer is `rolodeck_ingest`.

### The Diary's events Sources

Events come from named Sources, each tested offline against a capture in `db/fixtures/`.
`techmeme-events` reads Techmeme's own iCalendar feed, which lists conferences and so states no
attendance. The rest are Luma calendars, where the Diary's Attendance comes from: one parser,
`parseLumaCalendar` in `lib/ingest/luma-calendar.ts`, reads the schema.org JSON-LD every Luma
calendar publishes, and the calendars read are the entries in `LUMA_CALENDARS` — `luma-bond-ai-sf`,
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

### Scheduled runs

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
secret from "Ingest's credential" — never `SUPABASE_SECRET_KEY`. Each workflow's own
`concurrency` group serialises its runs, so a slow weekly run cannot overlap the next.

Trigger any of them by hand from the Actions tab — Actions → the workflow's name → **Run
workflow** — or with `gh workflow run ingest-sec-form-d.yml`; every one of them also carries a
`workflow_dispatch` trigger for exactly that, since the first thing anyone does with a broken
schedule is run it themselves.

A run's job summary reports what it inserted, updated and rejected, per Source, straight from
each script's own console output. A run that writes zero rows is a failure everywhere except
`ingest-news.yml`: every company-yielding Source and `ingest-events.yml` already exit non-zero
on an empty run — a rotted selector returns nothing and exits clean, which reads as "nothing new
today" at every layer above it unless the entry point itself refuses to call that success — but
News's own `newsRunFailed` (`lib/news/run.ts`) only trips when not one of its feeds could be
read. Until something is Kept there is nothing to match against, and a two-person startup can go a
month unreported after that, which is a quiet month and not a stale selector, so
`ingest-news.yml` does not treat zero articles as a failure. A feed that has changed shape is not
a quiet month either: it fails to parse, and is named in the job summary. A failed run opens or comments on a GitHub issue titled "Ingest failure: `<source>`", so
a Source down for a week produces one issue to read rather than seven to ignore.

### The run that never happened

A failed run is reported by the paragraph above. A run that never happened is not: it produces
no run, no failure and no issue, and a silently dead scraper reads exactly like a quiet week.
GitHub's scheduler is best-effort by its own documentation — delayed under load, occasionally
dropped, and disabled outright after a period of repository inactivity, which would stop every
Source at once. So `ingest-freshness.yml` runs daily at 16:10 UTC and asks of every Source
whether it has completed successfully since its own previous scheduled occurrence, plus six
hours of grace for that scheduling delay (`SCHEDULE_GRACE_MS` in `lib/ingest/freshness.ts`). One
that has not gets an issue titled "Ingest Source has not run: `<source>`", saying when it last
succeeded and when it should have — commented on rather than duplicated while it is still late,
the same one-issue-per-Source convention a failed run uses.

Which Sources are checked, and how often each is expected to run, come from the workflow files
themselves: a Source is a workflow in `.github/workflows/` that calls `ingest-run.yml`, and its
cadence is its own `schedule.cron`, read by `lib/ingest/workflow-schedules.ts` and turned into
scheduled occurrences by a real cron parser. Add a Source with a cron and it is watched; change
a cron and the check follows it. Nothing about a schedule is written down twice.

The check is itself a scheduled workflow, so whatever would silence every Source would silence
it too, and it cannot detect its own absence. It is partly self-healing — because the question
is "has it succeeded since its last occurrence", a check that misses a day reports the same
Source the next day with the gap intact rather than reset — but closing that properly needs a
watcher that does not depend on GitHub's scheduler at all.

### Filling a missing team from the company's own site

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

fetches every feed in `NEWS_FEEDS` (`lib/news/feeds.ts`) once — today, Techmeme's `/feed.xml` —
scores every article in them against every Kept Company Profile, never one that is unswiped or
Passed, and stores each pair in `news_items` with a `confidence` from `scoreNewsMatch` in
`lib/news/match.ts` for how sure it is that the article is about that company and not a
namesake. The page shows only items at or above `NEWS_DISPLAY_THRESHOLD` in the same file; the
rest stay stored, so the threshold can be retuned without fetching anything again. Running it
twice adds no rows: articles are keyed on `(profile_id, url)`.

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
total, and the worst offenders — companies appearing under the most sources. Matching uses the
same `name_key` the unique index on `profiles` uses, so case-insensitive and whitespace-insensitive
matching. Never writes to the database, only selects. See ADR 0008 for why `name_key` is the
identity rule.

## Database

The schema lives in `db/schema.ts`. After changing it, run `npm run db:generate` to write a
migration into `db/migrations/`, and commit the generated files.

`npm run db:migrate` applies pending migrations to the database at `DATABASE_URL`, which is
also the connection the app's own queries run on — as the `authenticated` role, with the
signed-in user's id in `request.jwt.claims`, so every RLS policy applies. See `docs/adr/0005`. Against
anything that is not a real Supabase project, apply `db/testing/supabase-shim.sql` first: it
supplies the `anon` and `authenticated` roles, the `auth` schema and `auth.uid()` that the
migrations and RLS policies expect. The test suite does this for you, against an in-process
Postgres, so no database needs to be running to run `npm run test`.
