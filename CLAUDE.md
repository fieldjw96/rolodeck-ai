# Rolodeck AI

A fully AI-authored build of the rolodeck concept: a swipeable deck of Bay Area startup
profiles. It began as a stress test of an unattended dispatcher and is now the product:
deployed at https://rolodeck-ai.vercel.app and built entirely through Runs.

The supervisor is `foreman`, which replaced `agent-harness` on 2026-09-10; that repo is
archived and nothing here should be read as depending on it. See `foreman/README.md` for how
Runs work, and [[CONTEXT]] plus `docs/adr/` for this repo's own vocabulary and decisions.

## Scope, and what this is not

**Founders are the subject of this product, not users of it.** There is no claim flow, no
founder login, and no founder-facing surface. Do not add one.

**V1 is single-player.** Jack is the only account. Auth exists from day one anyway, so
the app is not publicly readable and multi-user is additive later, not a migration. Do not
build sharing, invites, or per-audience visibility.

**This repo is unrelated to Jack's MBA notes vault.** Do not read from it, write to it, or
design toward integrating with it.

## Stack

TypeScript everywhere, `strict` plus `noUncheckedIndexedAccess`. Next.js App Router on
Vercel. Supabase for Postgres, Auth and Storage. Drizzle for schema and queries. Vitest for
unit and integration, Playwright for end to end. Zod at every external boundary.

## Rules

**Nothing in the browser talks to Postgres directly.** Reads and writes go through server
components and route handlers using the signed-in user's session. RLS is enabled on every
table as a hard backstop, never as the only control, so authorisation stays testable in
TypeScript.

**The service role key never leaves the server laptop.** It bypasses RLS completely. It is
for provisioning the one account and for running the auth tests against a real project, and it
never reaches a browser, a client bundle, OneDrive, or GitHub. Ingest does not use it.

**Ingest connects as `rolodeck_ingest`, and that is the one exception.** The role can select,
insert and update `profiles`, `news_items`, `events` and `event_attendances`, bypassing RLS on
those four tables only, and can do nothing else. Its connection string,
`ROLODECK_INGEST_DATABASE_URL`, is the only database credential permitted in GitHub Actions
secrets; `DATABASE_URL`, the service role key, and anything else that reaches Postgres or
Supabase stay off GitHub. Widening that role, or adding a second database credential to
Actions, needs a new ADR. See ADR 0013.

**The deploy workflow's `production` environment is the second, and ADR 0014 is that ADR.**
It holds `MIGRATION_DATABASE_URL` and `SUPABASE_POOLER_URL`, as environment secrets whose
deployment branches are restricted to `main`, for `.github/workflows/deploy.yml` alone. They
never become repository secrets, and no other workflow names them. The service role key is
not among them.

**Scraped data is hostile.** Every external field is parsed through a Zod schema at the
boundary. A site that changes shape must fail loudly, at the edge, naming the field, rather
than propagating `undefined` into a Profile.

**Every Profile field carries provenance**: `scraped`, `enriched`, or `jack`.

## Definition of done, here specifically

Most of this repo merges without Jack. A pull request merges itself once every required
check is green, the second-agent review Gate has approved it, and the branch is up to date
with `main`. Those rules are enforced by a GitHub branch ruleset rather than by the
supervisor, so they cannot be got wrong by a bug in ours.

Three paths are singled out in `.github/CODEOWNERS`: `.github/workflows/`, because it is the
Gate itself; `db/migrations/`, because reverting a commit does not unmake a schema change; and
CODEOWNERS, because a rule should not be editable by what it constrains.

**Those three are advisory, not enforced, and a Run must not read them as a gate it cannot
pass.** The ruleset's only bypass actor is the repository admin role, and Runs act as Jack, who
holds it. Worse, the rule they would otherwise trigger is unsatisfiable: GitHub does not let
anyone approve their own pull request, and a Run's pull request is authored by Jack, so his
code-owner approval on it is impossible rather than merely absent. rolodeck-ai#147 changed a
workflow and merged without him seeing it.

What they mean in practice is that a change to one of these paths is worth saying so plainly in
the pull request, because nothing will stop it. Making them real would mean the Runs having a
GitHub identity of their own; that was considered on 2026-09-18 and deliberately not done, on
the grounds that this is a single-player repo and every commit in it is Jack's anyway.

See ADR 0012, which supersedes ADR 0001. The `agent-harness` ADRs that ADR 0001 referred to
are archived along with that repo; `foreman` replaced it.
