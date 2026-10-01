---
status: accepted
---

# Google is the only front door, and the password path survives unlisted for the smoke test

Google SSO becomes the one advertised way into the app. Email and password stays, with no link
anywhere on the login page, used by the production smoke test and by nothing else. This amends
ADR 0004, which recorded that there is no sign-up flow at all and which rejected magic links.

## Why Google

Berkeley students hold Google Workspace accounts under `berkeley.edu` through **bConnected**, and
since January 2022 those logins are federated to **CalNet**. So "Sign in with Google" sends a
student to Google, then to CalNet including its 2-Step, then back. It is the login they already
use every day, which is the best onboarding friction available and is not something a password
form can match.

The decisive technical reason is quieter: **OAuth sign-in dispatches no email.** In
`supabase/auth`, a user arriving from an external provider that asserts a verified email is
confirmed in the database directly, with no mail sent. Google returns `email_verified` true for
ordinary accounts. So open self-service sign-up works with **no SMTP provider, no sending domain
and no email infrastructure of any kind**. Everything else on the menu requires all three.

## Why the password path survives

ADR 0004 rejected magic links on testability: _"a test cannot complete a magic-link sign-in
without reading an inbox."_ Supabase's Admin API can generate a sign-in link without sending
mail, which answers that for unit, integration and local tests. It does not answer it for the
production smoke test, because generating a link needs `SUPABASE_SECRET_KEY`, and ADR 0013 states
that key is forbidden in GitHub Actions. Something in `.github/workflows/deploy.yml` therefore
has to sign in with a password.

Keeping one unlisted credential, already built and already working, is a smaller cost than
widening ADR 0013's rule about which credentials may reach Actions. That rule is load-bearing and
should not be bent to save a login form.

## Consequences

**No sign-up form, no password strength rules, no password reset UI.** Google owns the credential
and the recovery story. `lib/auth/provisioning.ts` refuses to create a second account, which is
now misleading rather than protective: OAuth never calls it, so it guards a door nobody uses.

**ADR 0004's forgotten-password claim was never true for anyone but Jack.** It says Supabase's
hosted reset flow covers it. Supabase's built-in email sender refuses to deliver to addresses
outside the project's organisation, at two messages per hour, with no delivery SLA. The flow has
never been exercised by a second person because there has never been one.

**Magic link is deferred, not rejected.** It needs custom SMTP, which needs a domain that can
publish DKIM and SPF records. `*.vercel.app` cannot, and no provider sends from its own domain to
arbitrary recipients on a free tier. So the prerequisite is a domain, which is being bought for
other reasons anyway, and then roughly half an hour: verify it at a provider, paste SMTP
credentials into the Supabase dashboard.

**The Google OAuth project must be set to publishing status "In production", requesting only
`openid email profile`.** This is the detail that decides whether a beta user hits friction.
Those are non-sensitive scopes, so no Google verification is required, no unverified-app warning
appears, and there is no user cap. Left in **Testing**, the project caps at 100 manually-listed
test users, for the lifetime of the project and not resettable, and shows the warning screen. The
scopes requested in code must match the consent screen exactly or the warning appears anyway.

**One thing is unverified and should be settled by a person, not by research.** Google Workspace
admins can restrict third-party apps, and no UC Berkeley documentation states which setting
`berkeley.edu` uses. The Google-wide default is permissive, and even the middle setting
explicitly permits sign-in-only apps like this one, so the risk is small. It is not zero, and
students designated under 18 are blocked from unconfigured third-party apps by default on
Education editions, which can catch a 17-year-old first-year. One real `berkeley.edu` student
attempting a sign-in resolves it in ten minutes. If it fails, magic link is the fallback and the
cost of that failure is the domain purchase brought forward.

**`/auth/callback` is the first route added to the public list in `lib/auth/paths.ts` since
`/login`.** ADR 0004's second check still governs everything inside `app/(app)/`, and the Proxy
still refreshes session cookies, both unchanged. The callback has to be public because it is
reached before a session exists, which is exactly the kind of exception that makes a hardcoded
public list better than a pattern.
