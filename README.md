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
