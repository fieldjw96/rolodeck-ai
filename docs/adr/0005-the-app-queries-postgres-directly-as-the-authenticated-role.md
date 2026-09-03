---
status: accepted
---

# Route handlers query Postgres through Drizzle, as the `authenticated` role

Every read and write the app makes goes through `asUser()` in `db/rls.ts`: a transaction that
sets `request.jwt.claims` to the signed-in user's id and then `set local role authenticated`,
which is exactly the session PostgREST would have presented. Both settings are transaction
local, so they are gone at commit and cannot leak onto the next request that borrows the same
pooled connection. The user id comes from `getSessionUser()`, which revalidates the token
against Supabase Auth rather than believing a cookie.

The alternative was to reach Postgres through `@supabase/supabase-js` — PostgREST, over HTTP,
with the user's JWT — which is what a Supabase app usually does and would have needed no new
connection at all. It was rejected on testability, which is the same reason ADR 0004 gives for
its Auth stub. CLAUDE.md asks that authorisation stay testable in TypeScript, and the Ticket
asks for tests covering an empty page, a partial page, the final page, and a decision being
excluded from later pages. Against PostgREST those tests need a PostgREST; a fake client would
only prove the test knows what it stubbed. Against Drizzle they run on the in-process Postgres
from `db/testing/scratch-db.ts` — real SQL, the real policies, the real check constraints —
which is also what lets `db/deck.test.ts` assert that the anonymous role sees zero rows through
the very same handle the passing tests use. CLAUDE.md already names Drizzle for queries.

`DATABASE_URL` is therefore needed to run the app, not just to migrate it. It is not a second
RLS bypass: the connection role is a member of `authenticated` and every query drops to it. The
RLS-bypassing path remains the secret key in `lib/supabase/admin.ts`, which per CLAUDE.md
belongs to ingest and provisioning alone.

ADR 0004's two checks still hold for these endpoints, with one refinement each. In the Proxy,
a request under `/api` with no session gets a 401 carrying `{"error": "not signed in"}` rather
than a redirect: a fetch follows redirects, so the redirect would answer a caller that asked
for JSON with the login page and a 200 — the one shape it cannot tell from success. The
authoritative second check is `authenticated()` in `lib/api/authenticated.ts` rather than a
layout's `requireUser()`, because route handlers sit outside the `(app)` segment and no layout
runs above them; wrapping is what makes the check a property of the handler rather than of
somebody remembering.

## Considered Options

**PostgREST through `@supabase/supabase-js`.** No new connection, no new secret, and RLS is
applied by construction because the JWT travels with the request. Rejected for the reason
above: the Deck's pagination and exclusion rules would be the untested part of the system, and
they are the part most likely to be wrong.

**Drizzle on the connection's own role, filtering by `owner_id` in TypeScript only.** Simpler —
no role switch, no claims. Rejected: it makes RLS decorative, since a query that forgot its
`where` clause would return every account's rows. CLAUDE.md wants the policies underneath the
TypeScript, not instead of it, and `asUser()` is what puts them there.

**A `security definer` function per query.** Rejected as premature: it moves the Deck's rules
into SQL that Drizzle cannot type and the migration tests cannot easily read, to solve a
connection-pooling problem this deployment does not have.

## Consequences

The ownership filter is written twice for every query: once in the `where` clause and once in
the policy. That is the point — CLAUDE.md is explicit that RLS is a backstop and never the only
control — but it does mean a new query that forgets the filter still passes its tests, because
the policy quietly covers for it. `db/deck.test.ts` asserts both halves separately.

Serverless deployment means many short-lived connections, so `DATABASE_URL` should be
Supabase's pooled connection string; `db/connection.ts` sets `prepare: false` because the
transaction pooler hands a connection to a different client between statements. The connection
role must be a member of `authenticated`, which Supabase's `postgres` role already is.

Nothing in `swipes` can be reached by the anon role, and a decision cannot be recorded against
a Profile the user cannot see: the insert policy re-reads `profiles` through its own policy,
because a foreign key does not consult RLS. `db/deck.test.ts` proves that one directly, since
it is the sort of rule that is easy to write and easy to be wrong about.
