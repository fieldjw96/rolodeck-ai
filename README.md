# rolodeck-ai

A fully AI-authored build of the [rolodeck](https://github.com/fieldjw96/rolodeck) concept:
a swipeable deck of Bay Area startup profiles. Built through `agent-harness` Runs with
auto-merge on, as a stress test of the dispatcher running unattended.

See `CLAUDE.md` for the rules an agent works under here, `CONTEXT.md` for vocabulary, and
`docs/adr/` for why the auto-merge and data-sourcing decisions were made this way.

## Database

The schema lives in `db/schema.ts`. After changing it, run `npm run db:generate` to write a
migration into `db/migrations/`, and commit the generated files.

`npm run db:migrate` applies pending migrations to the database at `DATABASE_URL`. Against
anything that is not a real Supabase project, apply `db/testing/supabase-shim.sql` first: it
supplies the `anon` and `authenticated` roles, the `auth` schema and `auth.uid()` that the
migrations and RLS policies expect. The test suite does this for you, against an in-process
Postgres, so no database needs to be running to run `npm run test`.
