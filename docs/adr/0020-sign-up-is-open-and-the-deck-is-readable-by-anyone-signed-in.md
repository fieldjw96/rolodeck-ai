---
status: accepted
---

# Sign-up is open, and the Deck is readable by anyone who signs in

CLAUDE.md said _"V1 is single-player. Jack is the only account. Auth exists from day one anyway,
so the app is not publicly readable."_ The second half of that sentence is now false by choice.
Anyone who finds the URL may create an account, and once signed in they read the whole shared
Catalogue. There is no allowlist, no email-domain restriction, and no approval step.

The product reason is that the beta is mostly Berkeley classmates and the point is for them to
use the thing, not for Jack to administer a list. The honest cost is that "anyone" means anyone.

## Considered Options

**An allowlist Jack maintains.** Tightest, and an explicit door for the people he wants who are
not at Haas. Rejected: a list to maintain is a list that goes stale, and the first person who has
to ask to be added is the first person who does not bother.

**Restrict to `berkeley.edu`.** Matches the expected cohort with nothing to maintain. Rejected
because it excludes exactly the exceptions worth making. Worth recording for whoever revisits
this: Google's `hd` parameter is **not** the way to do it. Google's own documentation says _"Don't
rely on this UI optimization to control who can access your app, as client-side requests can be
modified."_ The enforcement point would be Supabase's Before User Created hook, checking the
verified email, and `hd` would be a UI nicety on top.

**New accounts land with an empty Deck until Jack approves them.** One Supabase hook, one click
per person, and a stranger finding the URL gets nothing. This was the recommendation and Jack
rejected it. It is the cheapest thing to reach for if open sign-up turns out to be a mistake.

## Consequences

**Nothing in the Catalogue is secret, and that is what makes this safe rather than reckless.**
Company Profiles are scraped from public sources — SEC filings, Show HN, accelerator pages — and
Provenance records which. What is private is the personal half per ADR 0019: who Kept what, and
each User's stated preferences. Those stay owner-scoped and RLS-enforced.

**Google is the bot protection, for as long as Google SSO is the only public door.** Supabase
supports hCaptcha and Cloudflare Turnstile, and neither is needed while every sign-up goes
through Google's own account creation. The moment magic link or password sign-up opens, Turnstile
becomes necessary. Note for whoever ships that: enabling CAPTCHA in the Supabase dashboard makes
Supabase **reject every auth call arriving without a token**, so the dashboard switch and the app
deploy are one coordinated change, and doing them in the wrong order locks everyone out of the
login. It would also break the smoke test's password sign-in until that path passes a token too.

**ADR 0006's justification for the rate limiter is gone, and the limiter stays anyway.** That ADR
keyed the limit on `user.id` because _"V1 has exactly one account and no unauthenticated surface
but `/login`"_. Both halves of that have changed. The limiter stays because a per-user limit is
weak against open sign-up in any case: the attack is more accounts, not more requests, and the
real control is that there is nothing in an account worth taking. ADR 0006 already names the
seam, `createRateLimiter()`, and a swap is one file when it is worth doing.

**Cost is not the constraint.** Supabase's Free plan includes 50,000 monthly active users.

**The project will not pause.** Supabase pauses Free projects showing low activity over seven
days, which for a beta would be a silent outage arriving in a quiet week. Five scheduled ingest
workflows write to this database every day, which clears the bar several times over. The coupling
is worth knowing rather than fixing: GitHub disables scheduled workflows after a period of
repository inactivity, which would stop every Source at once and pause the project a week later.
`.github/workflows/ingest-freshness.yml` watches for a Source that never ran and its own header
admits it cannot detect its own absence.
