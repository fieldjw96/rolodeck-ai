# rolodeck-ai

A fully AI-authored swipeable deck of Bay Area startup profiles, deployed at
https://rolodeck-ai.vercel.app. It began as a stress test of an unattended dispatcher and is
now the product; every line of it is written by Runs.

The supervisor is [`foreman`](https://github.com/fieldjw96/foreman), which replaced
`agent-harness` on 2026-09-10. Most pull requests here merge themselves once the checks are
green, the review Gate has approved, and the branch is current; the exceptions are in
`.github/CODEOWNERS` and the reasoning is in ADR 0010.

See `CLAUDE.md` for the rules an agent works under here, `CONTEXT.md` for vocabulary, and
`docs/adr/` for why the merge and data-sourcing decisions were made this way.

## Prerequisites

- Node 22.x and npm. `package.json`'s `engines.node` pins the same version CI and Vercel
  build with.
- A Supabase project: its URL, publishable key, secret key, and the pooled and direct
  Postgres connection strings, all from the project's dashboard. See `.env.example` for
  exactly which values and where each one lives.
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

## Deploying

This is a standard Next.js App Router project. `vercel.json` pins the install command, the
build command (`npm run build`) and the output directory (`.next`); `package.json`'s
`engines.node` pins the Node version, so Vercel builds with the same one CI does.

Deploying is: create a Vercel project pointed at this repository, set every variable from
`.env.example` in the Vercel project's Environment Variables with real values from the
Supabase dashboard (never the placeholders), and deploy. Only the `NEXT_PUBLIC_`-prefixed
ones are safe to also expose to Preview or Development environments; the rest —
`SUPABASE_SECRET_KEY`, `DATABASE_URL`, `SUPABASE_DB_URL` — are server-only per `CLAUDE.md` and
belong in Production alone. `ROLODECK_OWNER_ID` comes from running
`npm run account:provision` once, against the real project, before the first deploy matters.

The `build-with-documented-env` job in CI is what keeps this list honest: it builds with only
`.env.example`'s variables set, in a job with nothing else in its environment, so a variable
the app secretly needed but nobody documented fails there instead of on a fresh Vercel
project. Actually creating the Vercel project and connecting it to Jack's account is a manual
step outside any Ticket's scope.

## The Profiles API

Profiles reach the browser only through these route handlers, never by querying Postgres from
a client. All three require a session and answer `401` without one.

| Endpoint                      | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `GET /api/profiles`           | One page of the Deck, newest first                               |
| `POST /api/profiles/:id/keep` | Records a Keep, which drops the Profile from later pages         |
| `POST /api/profiles/:id/pass` | Records a Pass, which does the same without deleting the Profile |

`GET` takes `?limit=` (1 to 50, default 20) and `?cursor=`, and answers with the Profiles plus
a `next_cursor`, which is `null` on the last page. The cursor is opaque: hand back the one the
previous page issued. Anything else, including a limit outside its range, gets a `422` naming
the field it objected to.

All three share one budget of 60 requests a minute per account. Spend it and they answer `429`
with a `Retry-After` in seconds until the oldest request in the window ages out.

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
parses and nothing else: it does not fetch, and it does not write. Fetching, and discovering
which companies exist, is a separate concern — YC's directory listing is client-rendered and
cannot be scraped with a plain GET.

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
part of `npm test` or CI for that reason: it needs `SUPABASE_DB_URL` and `ROLODECK_OWNER_ID`,
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

The connection it writes through is its own: `getIngestDb()` in `db/connection.ts`, built from
`SUPABASE_DB_URL` rather than the app's own `DATABASE_URL`. That is the RLS bypass CLAUDE.md
and `docs/adr/0008` describe — the app's connection is a member of `authenticated` on purpose,
and every Source's fetch script needs the one that is not.

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
