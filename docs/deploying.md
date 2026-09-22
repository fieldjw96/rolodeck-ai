# Deploying

This is a standard Next.js App Router project. `vercel.json` pins the install command, the
build command (`npm run build`) and the output directory (`.next`); `package.json`'s
`engines.node` pins the Node version, so Vercel builds with the same one CI does.

**Merging to `main` is deploying.** `.github/workflows/deploy.yml` runs on every push to `main`
and on nothing else, and stops at the first step that fails:

1. Installs dependencies, the Vercel CLI among them, and the smoke test's browser, with no
   secret in the environment. Then it checks the commit is still the tip of `origin/main`,
   checks every secret below is present and that both database URLs are Supabase pooler URLs,
   and checks the Vercel project is reachable. Nothing in production has changed yet, so a
   missing secret costs nothing.
2. Sets the three variables the running app reads in Vercel's Production environment, after
   failing if Vercel holds `SUPABASE_SECRET_KEY` or `SUPABASE_DB_URL`, and checks the two
   browser-visible ones round-trip exactly. Vercel applies them to new deployments only, so
   this changes nothing already serving.
3. Applies pending migrations with `npm run db:migrate`. Production is a real Supabase
   project, so `db/testing/supabase-shim.sql` is never applied to it.
4. Checks `origin/main` has not moved, then deploys with `vercel deploy --prod`.
5. Runs `npm run smoke` against https://rolodeck-ai.vercel.app.

Re-running an old Deploy run fails at the tip-of-`main` check rather than rolling production
back: a re-run keeps its original commit, and drizzle, which applies only newer migrations,
would not stop it. To redeploy, re-run the latest one.

The CLI is the `vercel` devDependency, pinned exactly and run as `./node_modules/.bin/vercel`,
never `npx vercel@...`, whose unlocked dependencies would install inside a step holding the
token. Its dependency tree carried high and critical advisories, mostly in the builders and
dev server a remote `vercel deploy` never runs locally, and `package.json`'s `overrides` lift
each to a patched release so `npm audit` stays clean. Every one stays within its major except
undici, 5 to 6, which the CLI itself loads only when an HTTP proxy is configured.

A failed migration means no deploy. Any failure, or a cancelled run such as one that hits the
job's 30-minute timeout, opens an issue titled
`Deploy to production failed: <step>` linking the run; while that issue is open, a repeat
failure comments on it rather than opening a second. See `docs/adr/0014` for why migrations run
here, unattended, and not when the app boots.

Vercel's own Git integration is not connected, and must stay that way: it deploys the moment a
commit lands, which would race the migration. `vercel.json` sets `git.deploymentEnabled` to
`false` so that reconnecting it by mistake still would not deploy on push.
`scripts/deploy-workflow.test.ts` asserts that, the trigger, the step order and the variables
below.

## The workflow's secrets

Set these by hand as secrets of a GitHub environment named `production` (Settings →
Environments), with its deployment branches limited to `main`. That restriction is what keeps
them from a job on any other branch, including a workflow a pull request adds of its own;
repository-level secrets would not be withheld from it.

| Secret                                 | What it is                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`               | The privileged `postgres` connection migrations run as, through the session-mode pooler (`pooler.supabase.com`, port 5432). Not ingest's. |
| `SUPABASE_POOLER_URL`                  | The pooler URL the deployed app connects with; set in Vercel as `DATABASE_URL`.                                                           |
| `NEXT_PUBLIC_SUPABASE_URL`             | The project URL, as in `.env.example`.                                                                                                    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable key, as in `.env.example`.                                                                                                |
| `VERCEL_TOKEN`                         | A Vercel access token for the account that owns the `rolodeck-ai` project.                                                                |
| `ROLODECK_SMOKE_EMAIL`                 | The account `npm run smoke` signs in as.                                                                                                  |
| `ROLODECK_SMOKE_PASSWORD`              | Its password.                                                                                                                             |

Both database URLs must be pooler URLs, and the workflow refuses anything else before it
touches production. Supabase's direct host `db.<ref>.supabase.co` is IPv6-only, and neither
GitHub's runners nor Vercel's functions have IPv6 outbound.

`SUPABASE_SECRET_KEY` is deliberately not among them, and neither is
`ROLODECK_INGEST_DATABASE_URL`: the running app reads neither, so neither belongs in Vercel
either. The secret key is used only by `npm run account:provision`; the database
URL is ingest's. `ROLODECK_OWNER_ID` comes from running
`npm run account:provision` once, against the real project.

Two of these are database credentials, and CLAUDE.md otherwise allows only ingest's in GitHub
Actions. ADR 0014 is the ADR that widens that rule, and it widens it this far and no further:
`MIGRATION_DATABASE_URL` and `SUPABASE_POOLER_URL`, as secrets of the `production` environment
only, never as repository secrets. `scripts/deploy-workflow.test.ts` fails if the workflow names
any secret beyond the ones in this table.

`SUPABASE_DB_URL` is the name ADR 0013 retired; nothing reads it any more. The workflow no
longer sets it, and fails, before migrating, if Vercel's Production environment still holds it
or `SUPABASE_SECRET_KEY`. Remove either with `vercel env rm <name> production`, and keep
`deploy-rolodeck.ps1` from setting `SUPABASE_DB_URL` again.

The `build-with-documented-env` job in CI keeps `.env.example` honest: it builds with only
`.env.example`'s variables set, in a job with nothing else in its environment, so a variable
the app secretly needed but nobody documented fails there instead of in production.

## Break glass: deploying by hand

`C:\agent-runs\deploy-rolodeck.ps1` on the operations machine deploys the current `origin/main`
from there, reading `C:\agent-secrets\rolodeck-ai.env`. Use it when GitHub Actions is down, or
when the workflow itself is what broke:

```
powershell -ExecutionPolicy Bypass -File C:\agent-runs\deploy-rolodeck.ps1
```

It sets the app's variables and deploys, but it does **not** apply migrations, and it does not
check that `SUPABASE_DB_URL` is absent from Vercel, as the workflow does. If `main`
has any production lacks, run `npm run db:migrate` against production first. Its comments
record the two failures the workflow is built not to repeat: a UTF-8 BOM that PowerShell
prepends to a piped value, and the IPv6-only direct database host.

## Smoke testing a deployment

```
ROLODECK_SMOKE_EMAIL=... ROLODECK_SMOKE_PASSWORD=... npm run smoke
npm run smoke -- http://localhost:3000
```

Signs in to a running deployment and checks that the login page renders, that signing in
lands on the Deck, that the Deck deals a Company Profile out of Postgres, and that the
Watchlist renders. Exits non-zero if any of that fails.

**It writes nothing.** It never Keeps or Passes. Destructive testing belongs in
`npm run test:e2e:db`, which runs against a throwaway Postgres and a throwaway user; this
one runs against the real deployment and the real single account, so a Keep here would put a
Company Profile on the real account's Watchlist that nobody chose.

It exists for the class of failure a diff cannot show. Both real bugs in the first
deployment were of that kind: a UTF-8 BOM prepended to an environment variable, so every
sign-in failed against a URL that looked correct, and a database host that resolves locally
but not from a serverless function. Tests and review passed both.
