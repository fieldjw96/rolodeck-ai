---
status: accepted
---

# The rate limit goes in the route wrapper, the security headers go in the Proxy

Two checks that both apply to every request, put in two different places, for the same reason
ADR 0004 gives for writing the auth gate twice: each goes where the thing it protects is.

`authenticated()` in `lib/api/authenticated.ts` is the only code every route handler under
`/api` passes through, and by the time it runs there is a user id Supabase Auth has just
revalidated. So the limit is spent there, keyed on that id, out of one budget of 60 requests a
minute shared across the endpoints. Per authenticated user rather than per IP because V1 has
exactly one account and no unauthenticated surface but `/login`: an IP limit would be
protecting a door that is already locked, and would throttle a phone and a laptop behind one
NAT as though they were an attack. Shared across the endpoints rather than one budget each
because what is being protected — Supabase Auth on one side of the handler, Postgres on the
other — is itself shared, and three endpoints with 60 each is a budget of 180.

`lib/auth/gate.ts` already runs on every matched request and is the last code to touch the
response, whichever of its three answers it gives, so the security headers go on there rather
than in `next.config.ts`. That also keeps the Content-Security-Policy and the nonce it names in
one function: the policy is written on the response and the same nonce is set on the request,
where Next reads it back out and stamps it onto the inline scripts it emits. Split across two
files, those two could drift, and the failure mode is an app that renders with every one of its
own scripts blocked.

`npm audit --audit-level=high` and `npm run check:bundle-secrets` are steps in the same CI job
as the rest of the wall, so a vulnerable dependency or a secret in a client chunk blocks an
unattended merge exactly as a failing test does. See ADR 0001 for why that matters more here
than in a repo with a human reviewer.

## Considered Options

**A store outside the process — Redis, or Vercel KV.** The right answer for a real multi-tenant
API, and the wrong one here. The limiter is in memory, so on a platform that runs more than one
instance the effective limit is 60 per instance per minute, not 60 overall. That is a real
weakness, stated plainly rather than papered over: V1 is single-player, the account is Jack's,
and the limit exists to stop a loop in a client from hammering Supabase, not to hold off a
distributed attacker who does not have the one password. Adding a network round trip and a
second piece of infrastructure to every API request to fix an arithmetic error nobody can
currently trigger is not worth it. The seam is `createRateLimiter()`: a swap is one file.

**A fixed window instead of a sliding one.** Cheaper — one counter per key instead of a list of
hit times. Rejected because a fixed window lets a caller spend the whole budget in the last
second of one window and the whole of the next in the first second of the following one, which
is 120 requests in two seconds from a limit of 60. At 60 entries per key the list costs nothing.

**Rate limiting in the Proxy, alongside the auth gate.** One place, and it would cover Server
Actions too. Rejected on ADR 0004's argument: the Proxy's coverage is a property of a matcher
regex rather than of the code being protected, and the Ticket asks specifically that every route
handler under `/api` be limited.

**`'unsafe-inline'` in `script-src`, and no nonce.** Much simpler, and it is what a static
`next.config.ts` header block would have to say: Next emits inline bootstrap and RSC payload
scripts on every page, so without a nonce they have to be blanket-allowed. Rejected because a
`script-src` containing `'unsafe-inline'` stops nothing an injected script would want to do,
which makes the header decoration rather than defence.

**A nonce on `style-src` too.** Rejected: React writes inline `style` attributes, which no nonce
covers, and `next dev` injects stylesheets through JavaScript. `style-src 'self' 'unsafe-inline'`
is a deliberate loosening — injected CSS is a far smaller prize than injected script.

## Consequences

A page prerendered at build time carries no nonce at all, and `strict-dynamic` means even its
`<script src>` tags are refused: the page renders, and none of its JavaScript runs. `(app)`
already set `force-dynamic` and `/login` is dynamic for awaiting `searchParams`, but `next
build` was still prerendering `_not-found`, so `app/layout.tsx` now says `force-dynamic` for the
whole tree. Nothing is lost — every page here is behind a session and none of it was cacheable
— and a page added later cannot quietly reintroduce the problem.

`_global-error.html`, which Next builds for the case where the root layout itself throws, is
the one document still prerendered, and its scripts will be refused. It is a last-resort static
error page with nothing to hydrate, and the alternative is weakening the policy for every real
page to suit the one that only appears when the app is already broken.

The limiter's map is swept once per window, so a key that is never seen again is forgotten
rather than held for the life of the process.

`scripts/check-bundle-secrets.ts` overlaps `lib/supabase/client-boundary.test.ts` on purpose.
The test asks the source and names the offending line; the script asks the artefact, which is
where the answer is authoritative, because Next inlines `NEXT_PUBLIC_` variables at build time
and a rename can put a value in a chunk without any one source file looking wrong. It greps for
the variable names, and for their values when they happen to be set, and prints neither.

`npm audit` reaches the network, so CI now fails if the advisory database is unreachable. That
is the same trade the rest of the wall already makes with the npm registry.
