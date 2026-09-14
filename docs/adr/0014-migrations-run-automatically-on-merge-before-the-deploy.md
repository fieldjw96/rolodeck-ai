---
status: accepted
---

# Migrations run automatically on merge, before the deploy

Until Ticket #137, merging did not deploy and nothing applied migrations. Deploying was
`deploy-rolodeck.ps1`, run by hand on the server laptop, and migrating was nobody's job. Five
Tickets merged over two days and none of them reached `rolodeck-ai.vercel.app`; by the time
anyone looked, production was five migrations behind `main`.

## The decision

**Merging to `main` applies pending migrations and then deploys.** One workflow,
`.github/workflows/deploy.yml`, holds one job. Its steps run in a fixed order: migrate, set
the app's environment, deploy, smoke test. A failed step skips every step after it, so a
failed migration means no deploy. Drizzle applies every pending migration in a single
transaction, so a failed one also leaves the schema as it was. Schema goes first because the other order is the broken
one. Code that expects a table the database lacks fails every request that reads it. A schema
one merge ahead of the running code is what an additive migration is written to tolerate.

**The human checkpoint is the review, not the deploy.** ADR 0012 already makes
`db/migrations/` wait for Jack's own approval before it can merge. That approval is where a
person reads a schema change. Asking again at deploy time would be a second look at a diff
that has already merged. The gap between those two looks is exactly how production fell
behind. So nothing waits for Jack once a change is on `main`.

**This is the only automated path to production.** Vercel's Git integration stays
disconnected, because it deploys the moment a commit lands and would race the migration.
`vercel.json` also sets `git.deploymentEnabled: false`, so reconnecting it by mistake still
does not deploy on push. `deploy-rolodeck.ps1` stays, as the break-glass route when Actions or
this workflow is what broke.

**The migration credential is neither the app's nor ingest's.** Applying DDL needs the
privileged `postgres` connection. The scoped ingest role deliberately lacks those rights. The
app's connection needs none of them either, since ADR 0005 only requires its role to be a
member of `authenticated`. Keeping the migration credential separate is what leaves the app's
free to be narrowed to such a role without breaking migrations. The workflow reads the privileged one as `MIGRATION_DATABASE_URL`, a secret
of the `production` GitHub environment, whose deployment branches are restricted to `main`.
That asymmetry is the point. The one job that can change the schema runs only after a reviewed
merge, on `main`, with its secret withheld from every other ref. The connections that run
often, or unattended on a schedule, cannot change the schema at all. `SUPABASE_SECRET_KEY` is
not handed to the workflow either, since the running app never reads it.

**This widens ADR 0013's rule on Actions secrets, by exactly two credentials, in one
environment.** ADR 0013 allowed one database credential in GitHub Actions, ingest's, and said a
second needs a new ADR. This is that ADR. The deploy cannot run without two more: migrating
needs the privileged connection, and setting the app's variables in Vercel needs the app's
pooler URL, which `DATABASE_URL` is. So `MIGRATION_DATABASE_URL` and `SUPABASE_POOLER_URL` may be
secrets of the `production` environment, and nowhere else in Actions. They are not repository
secrets, because ADR 0013's concern was right: a repository secret is available to any workflow,
including one a pull request adds. An environment whose deployment branches are `main` only
gives them to a job on `main`, and nothing reaches `main` without review, with `deploy.yml`
itself also needing Jack's approval under ADR 0012. `ROLODECK_INGEST_DATABASE_URL` stays the only
database credential a scheduled or repository-wide workflow may hold. CLAUDE.md names this
exception, and `scripts/deploy-workflow.test.ts` fails if the workflow names any secret beyond
its list.

`SUPABASE_DB_URL`, which ADR 0013 retired, is still one of the four variables set in Vercel,
pointed at the same pooler URL as `DATABASE_URL`. Nothing reads it. It stays so the workflow and
`deploy-rolodeck.ps1` leave Vercel in the same state. It adds no credential Vercel does not
already hold, and it should be dropped from both routes together.

**Failure is loud.** A failed run opens a GitHub issue naming the step and linking the run, or
comments on the one already open, so it arrives in the same queue as every other piece of
work. After a successful deploy, `npm run smoke` signs in to production read-only. A deploy
that succeeds and serves a broken app therefore fails the job too.

## Rejected: running migrations when the app boots

- **It inverts the ordering this ADR exists for.** At boot the new code is already live. It
  would serve requests against the old schema until some instance got around to migrating, and
  if the migration failed, it would stay live against the old schema.
- **Serverless makes boot plural.** Vercel starts many function instances, cold, in parallel,
  and each one would race to migrate. Correctness would then rest on advisory locks, and the
  migration's latency would land on whichever request woke that instance.
- **It makes DDL rights a permanent requirement of the public host.** The running app needs
  only to reach `authenticated` (ADR 0005). Today its connection happens to be Supabase's
  `postgres` role, but nothing it does requires that, and it can be narrowed. Migrating at boot
  would forbid the narrowing, leaving the app, and anything that compromised it, forever able
  to drop tables.
- **A failure has nowhere to go.** At boot there is no job to fail and no issue to open. The
  failure becomes a 500 a user sees, which is the silence this Ticket was written to end.

## Consequences

A deploy that fails after a successful migration leaves the schema ahead of the running code.
That is tolerable for additive migrations and not for destructive ones. A migration that drops
or renames something the running code reads must ship in two merges: first the code stops
reading it, then the migration removes it. Jack's review of `db/migrations/` is where that is
caught.

Rollback stays manual, as it was. Promoting an earlier deployment in Vercel's dashboard rolls
back the code and not the schema, and the paragraph above is what makes that safe.

`drizzle-kit migrate` exits non-zero when a migration fails, which is all the ordering needs.
Its progress display, however, swallows the Postgres error. A failed migration step therefore
names no cause in its log, and the cause has to be found by running the migration against a
copy.

Until Jack sets the environment's secrets, every merge fails at the preflight step, before it
touches production, and the first failure opens an issue saying so. That is the workflow
behaving as intended, not an outage.
