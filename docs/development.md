# Development

## Prerequisites

- Node 22.x and npm. `package.json`'s `engines.node` pins the same version CI and Vercel
  build with.
- A Supabase project: its URL, publishable key, secret key, and its pooled Postgres
  connection string, all from the project's dashboard, plus a password you set for the
  ingest role, see "Ingest's credential" in `docs/ingest.md`. See `.env.example` for exactly which values
  and where each one lives.
- Nothing else. `npm run test` and `npm run test:e2e` both run against in-process
  stand-ins, a stub Postgres and a stub Supabase Auth backend, so no database or Supabase
  project needs to exist just to run the suite.

## Running it locally

Copy `.env.example` to `.env.local` and fill in the Supabase values, then `npm run dev`.

Every route is behind Supabase Auth except `/login`. There is no sign-up: V1 has one account,
and it is created by

```
npm run account:provision -- you@example.com
```

which needs `SUPABASE_SECRET_KEY`, generates the password, prints it once, and refuses to run
if the project already has an account. See `docs/adr/0004` for why the gate is written in two
places, and why the auth tests run against an in-process stub by default.

To run those tests against a real Supabase project instead of the stub, set `SUPABASE_TEST_URL`,
`SUPABASE_TEST_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`. Use a scratch project: the tests
create and delete users through the Admin API.

## Running the test suite

- `npm run typecheck`, `npm run lint` and `npm run format:check` need no environment at all.
- `npm run test` runs Vitest, unit and integration, against an in-process Postgres and the
  stub Supabase Auth backend from the section above. Nothing needs to be running first.
- `npm run test:e2e` runs Playwright against that same stub; the suite builds and starts its
  own server, so it needs no `.env.local` either.
- `npm run test:e2e:db` runs Playwright's swipe-flow suite (Ticket #13) against a real
  Postgres instead. Point `DATABASE_URL` at a scratch database, apply
  `db/testing/supabase-shim.sql` to it first (the same as `npm run db:migrate`; see "Database"
  below), then run the command. Here `DATABASE_URL` is the privileged connection the suite
  migrates with: it hands the app under test a `rolodeck_app` one it derives from it, so the
  browser's requests go through the same narrow role production uses.
- `npm run build` followed by `npm run check:bundle-secrets` confirms nothing server-only
  leaked into the client bundle; CI runs this pair on every pull request.

## Database

The schema lives in `db/schema.ts`. After changing it, run `npm run db:generate` to write a
migration into `db/migrations/`, and commit the generated files.

`npm run db:migrate` applies pending migrations to the database at `DATABASE_URL`. Against
anything that is not a real Supabase project, apply `db/testing/supabase-shim.sql` first: it
supplies the `anon` and `authenticated` roles, the `rolodeck_app` login, the `auth` schema and
`auth.uid()` that the migrations and RLS policies expect. The test suite does this for you,
against an in-process Postgres, so no database needs to be running to run `npm run test`.

Migrating and running the app are two different credentials under the same variable name, which
is why `DATABASE_URL` means different things in those two commands. The app's has to log in as
`rolodeck_app`, which migration 0012 creates: it cannot bypass RLS, and because it inherits
nothing from `authenticated` it holds no privilege on any table until `asUser()` drops to that
role for the length of a transaction, with the signed-in user's id in `request.jwt.claims`. So
a query that forgets `asUser()` is refused by Postgres rather than quietly answered with the
owner's own rows, and `getDb()` refuses a connection string that logs in as anything else. See
`docs/adr/0005` and `db/app-role.test.ts`. Migrating needs rights that role deliberately lacks,
so `npm run db:migrate` wants the privileged connection in `DATABASE_URL` instead — in
production they are separate secrets for exactly this reason (`docs/adr/0014`). On a scratch
database, `alter role rolodeck_app with password '<something>'` once; the migration sets none,
because it is committed.
