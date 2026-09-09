# rolodeck-ai

A fully AI-authored build of the [rolodeck](https://github.com/fieldjw96/rolodeck) concept:
a swipeable deck of Bay Area startup profiles. Built through `agent-harness` Runs with
auto-merge on, as a stress test of the dispatcher running unattended.

See `CLAUDE.md` for the rules an agent works under here, `CONTEXT.md` for vocabulary, and
`docs/adr/` for why the auto-merge and data-sourcing decisions were made this way.

## Running it

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
