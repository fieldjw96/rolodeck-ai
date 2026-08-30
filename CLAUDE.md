# Rolodeck AI

A fully AI-authored build of the rolodeck concept: a swipeable deck of Bay Area startup
profiles. This is the sibling of `fieldjw96/rolodeck`, built entirely through
`agent-harness` Runs with auto-merge on, as a stress test of the dispatcher running
unattended overnight. See `agent-harness/CLAUDE.md` for how the dispatcher works, and
[[CONTEXT]] plus `docs/adr/` for this repo's own vocabulary and decisions.

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

**The service role key is for ingest only.** It bypasses RLS completely. It lives on the
server laptop, is used by the scraper path, and never reaches a browser, a client bundle,
or OneDrive.

**Scraped data is hostile.** Every external field is parsed through a Zod schema at the
boundary. A site that changes shape must fail loudly, at the edge, naming the field, rather
than propagating `undefined` into a Profile.

**Every Profile field carries provenance**: `scraped`, `enriched`, or `jack`.

## Definition of done, here specifically

Unlike rolodeck, this repo merges without Jack: a pull request merges itself once
typecheck, lint, format, the full test suite, coverage on changed lines, and a build are
all green, and the second-agent review Gate has approved it. See `agent-harness` ADR 0004,
ADR 0009 and this repo's own ADR 0001 for why.
