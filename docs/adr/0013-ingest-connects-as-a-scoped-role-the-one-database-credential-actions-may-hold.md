---
status: accepted
---

# Ingest connects as a scoped Postgres role, and that is the one database credential GitHub Actions may hold

Scheduled ingest is moving to GitHub Actions. Whatever credential it runs under will then live in
a third place, alongside the server laptop and `C:\agent-secrets`, and Actions secrets are the
least controlled of the three: available to any workflow in the repository, and one careless
step away from a log.

Until now ingest wrote through `SUPABASE_DB_URL`, logging in as `postgres`. CLAUDE.md called that
path "the service role key", and ADRs 0003 and 0008 describe it the same way; the precise
credential was different but the reach was the same — `postgres` bypasses RLS and holds
privileges on every table, `swipes`, `user_profiles` and `auth.users` included. One script,
`scripts/ingest-sec-form-d.ts`, went further still and wrote through the app's own `DATABASE_URL`.
Ingest needs four tables. Putting a credential for all of them in Actions would be the wrong
trade.

## The decision

**Ingest logs in as `rolodeck_ingest`, a role that can do what ingest does and nothing else.**
Migration `0008_ingest_role` creates it with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
NOREPLICATION NOBYPASSRLS`, a member of no other role, and grants it:

- `SELECT`, `INSERT` and `UPDATE` on `profiles`, `news_items`, `events` and `event_attendances`;
- `DELETE` on `event_attendances` alone, because `persistEvents` replaces an Event's Attendance
  on every run so that a company a Source stops naming stops being linked;
- `EXECUTE` on `ingest.kept_profile_ids(uuid)`, described below.

It has no grant on `swipes`, `user_profiles` or anything in `auth`, and no `TRUNCATE`, `DELETE`,
`REFERENCES` or `TRIGGER` on its own tables beyond the one `DELETE` above.

**It bypasses RLS on its four tables through policies, not through `BYPASSRLS`.** Each of the
four carries permissive `select`, `insert` and `update` policies `TO rolodeck_ingest` with
`using (true)` and `with check (true)`, plus a `delete` policy on `event_attendances`. They are
declared in `db/schema.ts`, so they are part of the schema Drizzle diffs. Ingest writes rows
owned by the account rather than by itself, and there is no `auth.uid()` in its session for an
ownership policy to match, so admitting the role outright is the only policy that fits.

This does not expose the tables it has no grant on, for two independent reasons. A policy
belongs to one table and says nothing about any other, and no table but these four has a policy
naming this role. And Postgres checks the table privilege before RLS is consulted at all: on
`swipes`, `user_profiles` or `auth.users` the role fails with "permission denied" whatever any
policy says. `BYPASSRLS` was rejected because it is a role attribute, not a table one: it would
waive RLS on every table the role can ever be granted, today's and tomorrow's, leaving grants as
the only line.

**News learns what is Kept through one `SECURITY DEFINER` function.** News searches for Kept
Company Profiles, and Kept lives in `swipes`. `ingest.kept_profile_ids(owner)` returns the profile
ids that owner Kept and nothing else: it runs as its owner, the migrating role, with an empty
`search_path` so nothing ingest could create changes what its body resolves to. It lives in its
own `ingest` schema rather than `public`, because PostgREST exposes `public` functions as RPC and
Supabase grants `EXECUTE` on them to `anon` by default; `EXECUTE` is revoked from `PUBLIC`, `anon`
and `authenticated` and granted to `rolodeck_ingest` alone.

**The migration checks its own work, on every database it runs against.** Its last statement
fails the migration if the role is a superuser, can create roles or databases, replicates,
bypasses RLS, belongs to any role, or holds any privilege — directly, through `PUBLIC`, or on a
column — on a relation in `public` or `auth` beyond its four tables, or `TRUNCATE` or an unlisted
`DELETE` on those. The tests run against a scratch Postgres with a shim for Supabase's roles; this
is what asks the same question of the real project, where the tests never run.
`db/ingest-role.test.ts` broadens the role each of those ways and watches the check refuse it.

**The connection string is `ROLODECK_INGEST_DATABASE_URL`, and it must log in as the role.**
Named for what it is, and unlike `DATABASE_URL`, so neither can be pasted into the other's place.
`lib/ingest/env.ts` refuses it unless its user is `rolodeck_ingest`, or
`rolodeck_ingest.<project-ref>` through Supabase's pooler: the scoping lives in the role, so the
`postgres` connection string under the scoped name would be precisely a credential that looks
scoped and is not. `getIngestDb()` moved to `db/ingest-connection.ts`, and `readOwnerId()` to
`lib/ingest/env.ts`, so that nothing an ingest entry point loads names the secret key or reaches
the app's connection; `lib/ingest/credential-boundary.test.ts` walks each entry point's runtime
imports to hold that.

## Actions secrets may hold exactly one database credential, this one

Actions already holds a credential that is not a database one — the review Gate's
`CLAUDE_CODE_OAUTH_TOKEN` — and nothing here changes that. CLAUDE.md's rule about the service
role key said where that key lives and did not say where any other database credential may. Scheduled ingest makes that silence a decision, so it is taken here
explicitly: `ROLODECK_INGEST_DATABASE_URL` is permitted in GitHub Actions secrets. Nothing else
that reaches Postgres is — not `DATABASE_URL`, which can act as any account through `asUser()`, and
not `SUPABASE_SECRET_KEY`, which bypasses RLS everywhere and administers Auth.

CLAUDE.md is amended to say so rather than leaving the exception to be inferred from a workflow
file. A hard rule with an undocumented exception stops being a rule: the next Run to read "never
reaches GitHub" beside a workflow that plainly uses a database secret has to guess which of the
two is wrong, and the cheaper guess is always that the rule is. Stating the exception, naming the
one credential it covers, and saying that widening it needs another ADR keeps the rule
checkable.

## Considered Options

**`BYPASSRLS` on the role, with grants as the only boundary.** Simplest, and the grants alone do
keep it off `swipes` today. Rejected for the reasons above: it applies to every table at once, so a later
`grant` on a new table silently includes an RLS bypass nobody chose.

**A `SECURITY DEFINER` function for every write.** The narrowest possible surface: the role
would hold `EXECUTE` and no table rights at all. Rejected because every write path ingest has —
`persistProfiles`, `persistEvents`, `persistNewsItems`, each an idempotent upsert with per-row
`xmax` counting — would move into SQL that Drizzle cannot type, for the same reason ADR 0005
declined per-query functions. The one read that genuinely needs another table's data is a
function; the writes are not.

**Granting `SELECT` on `swipes` so News can join it.** One line, and the role still could not
write there. Rejected: ingest would then read every account's every decision, and the Ticket asks
for no rights on `swipes` at all. The function hands out exactly the one fact News uses.

**Keeping the service-role credential but only in Actions, not also on the laptop.** Moves the
risk rather than reducing it.

## Consequences

The migration touches `db/migrations/`, so per ADR 0012 it waits for Jack. Once applied, the role
has no password: Jack sets one by hand in the Supabase SQL editor and builds the connection
string, as the README's "Ingest's credential" section describes. No Run ever holds it.

A new table ingest needs to write gets nothing automatically — Supabase's default privileges name
`anon`, `authenticated` and `service_role`, not this role — so the migration adding it has to grant
the role and add its policies, and the check at the end of `0008` has to learn the new table name
or it will refuse the next migration that runs it. That is deliberate: widening ingest should take
an explicit step that a reviewer sees.

`SUPABASE_DB_URL` is gone, replaced rather than repurposed, so a laptop still carrying the
`postgres` connection string under the old name fails loudly naming the new one instead of
continuing to write as a superuser. `SUPABASE_SECRET_KEY` stays where it is for
`scripts/provision-account.ts` and the auth tests against a real project.

ADRs 0003, 0005 and 0008 still say "service role" or "secret key" where they describe the ingest
path. They are left as written, as records of what was decided when; this ADR is what now
describes the credential that path holds.
