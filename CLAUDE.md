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

**Anyone may sign up, and a signed-in User reads the whole Catalogue.** This reverses the rule
that stood here until 2026-10-01, that V1 was single-player and the app was not publicly
readable. Sign-in is Google SSO; there is no allowlist, no email-domain restriction and no
approval step. See ADR 0020 for the decision and ADR 0021 for the mechanism.

**The Catalogue is shared and nothing owns it.** Company Profiles, Founders, News, Events and
Attendances carry no `owner_id` and are the same rows for every User. What is private is the
personal half: a User's swipes and their User Profile, both owner-scoped and both enforced by
RLS. That line is the one to keep: a new table belongs on one side of it, deliberately. See
ADR 0019.

**Still do not build sharing, invites, or per-audience visibility.** Multi-user means many
people reading one Catalogue, not people showing each other things. There is no role above
User and no administrator surface.

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
TypeScript. For that backstop to be real, `DATABASE_URL` must connect as a non-superuser role
that is merely a member of `authenticated`: Supabase's `postgres` role bypasses RLS, which makes
a query that forgets `asUser()` unprotected rather than merely untidy. See ADR 0005.

**The service role key never leaves the server laptop.** It bypasses RLS completely. It is for
running the auth tests against a real project, and it never reaches a browser, a client bundle,
OneDrive, or GitHub. Ingest does not use it, and account provisioning no longer needs it now
that Google SSO creates accounts.

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
pass.** See ADR 0017, which amends ADR 0012 on this one point: the approval ADR 0012 described
was never enforced and cannot be, because the ruleset's only bypass actor is the admin role the
Runs act as, and a Run's pull request is authored by Jack, who cannot approve his own.

What they mean in practice is that a change to one of these paths is worth saying so plainly in
the pull request, because nothing will stop it.

See ADR 0012, which supersedes ADR 0001. The `agent-harness` ADRs that ADR 0001 referred to
are archived along with that repo; `foreman` replaced it.
