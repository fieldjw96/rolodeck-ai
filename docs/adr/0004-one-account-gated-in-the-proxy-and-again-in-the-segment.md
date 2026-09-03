---
status: accepted
---

# The whole app is gated twice: once in the Proxy, once in the route segment

Supabase Auth protects every route except `/login`. The check is written down in two places
on purpose.

`proxy.ts` runs `lib/auth/gate.ts` on every matched request. It calls `getUser()`, which
revalidates the token against Supabase Auth rather than believing a cookie the browser sent,
and redirects to `/login` when there is no user. It is also the only place in a Next app that
can write refreshed auth cookies back onto the response, which is why Supabase's own guidance
puts session refresh in middleware and why it cannot simply be deleted in favour of the
second check.

`app/(app)/layout.tsx` then calls `requireUser()` for itself. Next's own authentication guide
is explicit that a Proxy is an optimistic check and not an authorisation boundary: a matcher
change, or a Server Action moving to a route the matcher excludes, silently removes that
coverage. Putting the authoritative check in the layout of a route group means a page added
tomorrow is gated by where it sits in the tree rather than by someone remembering. RLS is
still underneath both, per CLAUDE.md, as the backstop neither can bypass.

There is no sign-up flow anywhere, and `lib/auth/provisioning.ts` refuses to create a second
account. CLAUDE.md's V1 is single-player; a self-service route into a deployment meant to have
exactly one user is a way in for everybody else. `npm run account:provision -- <email>` is the
only way an account comes into existence, it generates the password rather than accepting one,
and it runs on the server laptop where the secret key already lives.

## Considered Options

**The Proxy alone.** Fewer places for the rule to drift apart. Rejected: Next documents the
Proxy as an optimistic filter, and a Server Function is a POST to whatever route it is used
on, so the gate's coverage is a property of a regex rather than of the code being protected.

**`requireUser()` alone, no Proxy.** Rejected: Server Components cannot write cookies, so a
refreshed session would be recomputed on every request and never persisted. Supabase warns
that this produces exactly the failure it is hardest to diagnose — random logouts.

**Magic links instead of a password.** Attractive, since it removes the credential entirely.
Rejected for testing reasons: a test cannot complete a magic-link sign-in without reading an
inbox, and the Ticket requires tests that create a throwaway account and sign in as it with no
fixed credentials anywhere. Supabase's hosted reset flow covers a forgotten password.

## Consequences

The gate makes a request to Supabase Auth on every matched navigation. For one user on a Deck
this is not worth optimising, but it is the reason the matcher excludes static assets.

Integration tests need a Supabase Auth to sign in against, and CI has no Supabase project. The
tests therefore run against `lib/auth/testing/gotrue-stub.ts`, an in-process server speaking
the handful of GoTrue endpoints this app uses — the same move `db/testing/supabase-shim.sql`
makes for Supabase's managed roles, and for the same reason: the question "does the gate turn
an unsigned request away, and let a signed one through?" gets answered on every push with
nothing to provision. The clients on the near side are the real `@supabase/ssr` and
`@supabase/supabase-js`, so the cookie handling under test is the production code path.

The stub can drift from real GoTrue, and nothing in CI would notice. The same test body runs
against a live project when `SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY` and
`SUPABASE_SECRET_KEY` are set, which is how that drift gets caught — deliberately, by someone
running it, rather than on a schedule. Those tests create and delete their own users through
the Admin API, so they must never be pointed at the project holding real Profiles.
