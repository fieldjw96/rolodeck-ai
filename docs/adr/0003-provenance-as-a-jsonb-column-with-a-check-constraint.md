---
status: accepted
---

# Per-field provenance lives in one jsonb column on `profiles`, guarded by a check constraint

`CONTEXT.md` carries Provenance per field, not per Profile, so a Profile whose `name` Jack
corrected sits next to a `sector` that is still whatever the scraper found. The database
records that as a single `provenance` jsonb column on `profiles`, keyed by field name, with
a check constraint that rejects any row where a Profile field has no provenance or an
unrecognised one.

The constraint matters more than it looks. Postgres accepts a CHECK that evaluates to NULL,
and `null in ('scraped', 'enriched', 'jack')` is NULL, so a missing key would pass a naive
predicate; the expression is wrapped in `coalesce(..., false)` for exactly that reason. Zod
guards the boundary in TypeScript, but the service-role ingest path bypasses RLS, and a
check constraint is the one control it cannot bypass.

## Considered Options

**A normalised `profiles_provenance` table, one row per Profile field.** Provenance values
become foreign keys rather than strings, and adding a field does not mean rewriting rows.
Rejected: every read of a Profile is a read of its provenance — nothing in the product ever
wants one without the other — so the join buys nothing, and "every field has exactly one
provenance" becomes a constraint spread across rows rather than one a single CHECK can
state.

**A separate provenance column per field: `name_provenance`, `sector_provenance`, and so
on.** The most rigid option; a Postgres enum type would make invalid values unrepresentable
and a missing value a NOT NULL violation. Rejected: it doubles the column count and turns
every new Profile field into two migrations, on a schema this early that is still moving.

**No database-level constraint, Zod only.** Rejected: it makes the ingest path, which runs
under the service role and bypasses RLS, the only thing standing between a scraper change
and an unattributed Profile. See ADR 0002 — the scraper merges unreviewed too.

## Consequences

Adding a Profile field means editing the Zod schema, the jsonb shape, and the check
constraint together, in one migration. Provenance values are not indexable per field
without an expression index, which nothing needs yet: the Deck filters on `sector` and
`stage`, not on where they came from.

Testing the RLS policy needs a Postgres that has Supabase's `anon` and `authenticated`
roles and an `auth.uid()`, which a stock server does not. `db/testing/supabase-shim.sql`
supplies exactly those, and the integration tests run it against an in-process Postgres, so
"does the policy actually deny anon?" is a question the test suite answers on every push
with no container to start. CI applies the same shim to a real scratch Postgres before
`npm run db:migrate`, so the generated SQL is proven against a real server too.
