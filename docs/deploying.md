# Deploying

This is a standard Next.js App Router project. `vercel.json` pins the install command, the
build command (`npm run build`) and the output directory (`.next`); `package.json`'s
`engines.node` pins the Node version, so Vercel builds with the same one CI does.

**Merging to `main` is deploying.** `.github/workflows/deploy.yml` runs on every push to `main`
and on nothing else, and stops at the first step that fails:

1. Installs dependencies, the Vercel CLI among them, and the smoke test's browser, with no
   secret in the environment. Then it checks the commit is still the tip of `origin/main`,
   checks every secret below is present, that both database URLs are Supabase pooler URLs, and
   that `MIGRATION_DATABASE_URL` is the session-mode pooler and the privileged connection, and
   checks the Vercel project is reachable. Nothing in production has changed yet, so a missing
   secret costs nothing. It does not yet check which role `SUPABASE_POOLER_URL` logs in as:
   migration 0012 is what creates that role, and this runs before migrations do.
2. Sets the three variables the running app reads in Vercel's Production environment, after
   failing if Vercel holds `SUPABASE_SECRET_KEY` or `SUPABASE_DB_URL`, and checks the two
   browser-visible ones round-trip exactly. Vercel applies them to new deployments only, so
   this changes nothing already serving.
3. Applies pending migrations with `npm run db:migrate`. Production is a real Supabase
   project, so `db/testing/supabase-shim.sql` is never applied to it.
4. Now that migrations have run, checks `SUPABASE_POOLER_URL` logs in as `rolodeck_app` and
   not `postgres`. Failing here costs nothing further: migrations are idempotent and
   re-runnable, and nothing has deployed yet.
5. Checks `origin/main` has not moved, then deploys with `vercel deploy --prod`.
6. Runs `npm run smoke` against https://rolodeck-ai.vercel.app.

Re-running an old Deploy run fails at the tip-of-`main` check rather than rolling production
back: a re-run keeps its original commit, and drizzle, which applies only newer migrations,
would not stop it. To redeploy, re-run the latest one.

The CLI is the `vercel` devDependency, pinned exactly and run as `./node_modules/.bin/vercel`,
never `npx vercel@...`, whose unlocked dependencies would install inside a step holding the
token. Its dependency tree carried high and critical advisories, mostly in the builders and
dev server a remote `vercel deploy` never runs locally, and `package.json`'s `overrides` lift
each to a patched release so `npm audit` stays clean. Every one stays within its major except
undici, 5 to 6, which the CLI itself loads only when an HTTP proxy is configured.

That mechanism only works where a patched release exists to point at, which is not always. See
`docs/adr/0022`: the CI gate now covers what ships and reports the rest, because an advisory
with no fix anywhere in the dev tree had otherwise frozen the whole repository.

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
| `SUPABASE_POOLER_URL`                  | The pooler URL the deployed app connects with, logging in as `rolodeck_app.<project-ref>`; set in Vercel as `DATABASE_URL`.               |
| `NEXT_PUBLIC_SUPABASE_URL`             | The project URL, as in `.env.example`.                                                                                                    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable key, as in `.env.example`.                                                                                                |
| `VERCEL_TOKEN`                         | A Vercel access token for the account that owns the `rolodeck-ai` project.                                                                |
| `ROLODECK_SMOKE_EMAIL`                 | The account `npm run smoke` signs in as.                                                                                                  |
| `ROLODECK_SMOKE_PASSWORD`              | Its password.                                                                                                                             |

Both database URLs must be pooler URLs, and the workflow refuses anything else before it
touches production. Supabase's direct host `db.<ref>.supabase.co` is IPv6-only, and neither
GitHub's runners nor Vercel's functions have IPv6 outbound.

The two must also log in as different roles. The preflight refuses `MIGRATION_DATABASE_URL`
being `rolodeck_app.<project-ref>`, because applying DDL needs rights that role deliberately
lacks. The other direction — `SUPABASE_POOLER_URL` has to be `rolodeck_app.<project-ref>` and
not `postgres` — is checked later, by **Check the app role the migration created**, after
migrations have applied rather than in the preflight: migration 0012 is what creates
`rolodeck_app`, so a database that has never run it has no such role yet, and refusing the
secret for that before the migration gets a chance to run would deadlock every first deploy
(Ticket #203). `rolodeck_app` cannot bypass RLS and holds no table privilege until `asUser()`
drops it to `authenticated`, which is what makes a query that forgets its session fail instead
of returning somebody's rows (Ticket #188, `docs/adr/0005`).

### Setting the app's role up, by hand, once

Migration 0012 creates `rolodeck_app` itself, the first time it runs — nobody needs to create
the role. The only thing a person must do by hand is give it a password, because the migration
is committed and a password is not.

On a database that has only ever run migrations up to 0011, `rolodeck_app` does not exist yet,
so `SUPABASE_POOLER_URL` cannot name it yet either. Set it to any Supabase pooler URL for now —
the `postgres` one Supabase gives by default works — so the preflight's presence and
pooler-URL-shape checks pass; it does not yet check which role the string logs in as. The merge
runs migration 0012, which creates `rolodeck_app`, and then fails at **Check the app role the
migration created** naming the secret as wrong, since it still logs in as `postgres`. That
failure is expected and costs nothing: migrations already applied, and nothing has deployed.

Then, in the Supabase SQL editor, now that migration 0012 has run and the role exists:

1. `alter role rolodeck_app with password '<a long random password>';` Use letters and digits
   only: anything else has to be percent-encoded inside a connection string, and a wrong
   encoding fails as an authentication error rather than as a parse error.
2. Build the connection string from the pooler's, with `rolodeck_app.<project-ref>` as the user
   in place of `postgres.<project-ref>`, and the password from step 1. The dashboard's current
   path to it is the **Connect** button in the project's top bar, which offers Direct,
   Transaction pooler and Session pooler; take **Transaction pooler**, port 6543, since
   `db/connection.ts` sets `prepare: false` for it. Delete any query parameter the dashboard
   appends, such as `?pgbouncer=true`: the preflight allows none but `sslmode`.
3. Put it in the `production` environment as `SUPABASE_POOLER_URL`, replacing the placeholder.
   That is the only place it goes. The deploy writes Vercel's own `DATABASE_URL` from it — see
   **Set the production environment variables** in the workflow — so there is nothing to paste
   into the Vercel dashboard.

Re-run the Deploy run (or merge again) once step 3 is done. Migration 0012 is guarded with
`IF NOT EXISTS` and re-runs harmlessly, **Check the app role the migration created** now passes,
and the deploy ships. Until then, the workflow is behaving as intended: the role is the whole
guarantee, and nothing in this repository can change a GitHub secret on its own.

Note that a re-run of the _failed_ run will not do: it refuses to ship a commit `main` has moved
past, by design (Ticket #149). Re-run the Deploy run for the current tip, or merge anything.

### Running the app locally, without putting a credential in OneDrive

This section used to end by saying to put the same string in `.env.local` as `DATABASE_URL`.
**Do not.** This repository's working directory is itself a OneDrive-synced folder, and
CLAUDE.md's rule is absolute: secrets never enter OneDrive, "not in a `.env`, not in a script,
not temporarily". `.gitignore` does nothing about sync, version history, or a share link. The
instruction and the rule could not both be followed, and the rule wins.

Set `DATABASE_URL` as a **machine-level environment variable** instead, or keep it in a file
under `C:\agent-secrets`, which is on local disk and is where the other runtime credentials
already live. `next dev` reads the process environment, so an exported variable is all it wants,
and `C:\agent-runs\dev` is the working directory CLAUDE.md already nominates for a dev server
for the same reason.

`SUPABASE_SECRET_KEY` is deliberately not among them, and neither is
`ROLODECK_INGEST_DATABASE_URL`: the running app reads neither, so neither belongs in Vercel
either. The secret key is used only by `npm run account:provision`, which creates and rotates the
smoke test's one password account; the database
URL is ingest's. `ROLODECK_NEWS_KEEPS_USER_ID`, which only `npm run ingest:news` reads, is a
user id from the Supabase dashboard; it names whose Keeps News gathers for, per ADR 0019, and
owns nothing.

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

Signs in to a running deployment and checks that `/login` offers Google, that the unlisted
`/login/password` form renders, that signing in through it lands on the Deck, that the Deck deals a Company Profile out of Postgres, and that the
Watchlist renders. Exits non-zero if any of that fails.

**It writes nothing.** It never Keeps or Passes. Destructive testing belongs in
`npm run test:e2e:db`, which runs against a throwaway Postgres and a throwaway user; this
one runs against the real deployment and the real smoke-test account, so a Keep here would
put a Company Profile on that account's Watchlist that nobody chose.

It exists for the class of failure a diff cannot show. Both real bugs in the first
deployment were of that kind: a UTF-8 BOM prepended to an environment variable, so every
sign-in failed against a URL that looked correct, and a database host that resolves locally
but not from a serverless function. Tests and review passed both.
