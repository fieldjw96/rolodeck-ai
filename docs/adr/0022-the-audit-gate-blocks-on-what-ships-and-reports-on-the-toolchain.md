---
status: accepted
---

# The audit gate blocks on what ships, and only reports on the toolchain

`npm audit --audit-level=high` is a step in the same CI job as typecheck, lint and the tests,
and it is deliberately the first one, so a known-vulnerable dependency stops a merge the way a
failing test does. That stays true for every dependency that reaches production. For the
dev-only tree it is now a warning rather than a gate: a second, `continue-on-error` step audits
the whole tree and marks the job yellow instead of red.

## Why it changed

The repository froze twice in three days on advisories nobody here could act on, and the second
one had no fix at all.

**2026-10-01.** `npm audit` began failing every pull request, including one that changed only
markdown. Three findings were at or above the threshold: a **critical** remote code execution in
`next/og` and high-severity advisories in `undici` and `brace-expansion`. That one was worth
every bit of the disruption — `next` is a production dependency on a deployed application, and
the wall did exactly its job. Patched in Ticket #192.

**2026-10-04.** A **high** advisory in `braces`: stack-exhaustion denial of service through
deeply nested patterns. It reaches this repository only through linting —
`eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` — and
**no patched version exists**. `braces@3.0.3` is the latest published release and the advisory
covers all versions, so the `overrides` block that lifts seven other transitive dependencies to
patched releases cannot help. `npm audit`'s only suggested remedy was downgrading
`eslint-config-next` from 16.3.8 to 14.2.35.

The cost of the second one was out of all proportion to the risk. The audit step runs first, so
its failure **skips typecheck, lint, format, the tests and the build** — the job dies at step
one and reports nothing about the change under review. Every pull request and every unattended
Run was blocked, waiting on a stranger to publish a patch, for a denial of service in a glob
matcher that runs during `eslint` and ships nowhere.

`npm audit --omit=dev --audit-level=high` exits 0 against this tree, reporting no
vulnerabilities at all.

## Considered Options

**Wait for a patch.** Correct in principle and unusable in practice: the repository is frozen
for an unbounded period, decided by somebody else's release schedule, and ADR 0012's unattended
merge means that freeze also stops every Run.

**Downgrade `eslint-config-next` to 14.2.35.** What `npm audit fix --force` offers. Rejected:
two major versions back, to match a Next 14 era lint config against a Next 16 application, to
remove a lint-time glob matcher. The cure is far worse.

**Override `braces` to a patched release**, as `overrides` already does for `js-yaml`,
`minimatch`, `path-to-regexp`, `smol-toml`, `tar` and `undici`. Not possible: there is no
patched release to point at. Worth recording, because it is the first thing the next person will
reach for and the mechanism is already in the file.

**Lower the threshold to `critical`.** Fewer stoppages, and it would also have let a
high-severity TLS certificate validation bypass in `undici` through unremarked. The threshold is
not the thing that is wrong.

**Keep one step and ignore specific advisories.** `npm audit` has no per-advisory exclusion, so
this means a wrapper script holding a list of advisory ids. Rejected: that list is a thing
somebody must prune, nobody does, and it silently covers for the next advisory that shares an id
prefix. A rule about _what ships_ needs no maintenance.

## Consequences

**What this still catches is the thing that actually happened.** The `next/og` critical would
fail the blocking step today, unchanged: `next` is a production dependency. So would anything in
`@supabase/ssr`, `drizzle-orm`, `postgres`, `react` or `zod`.

**What it gives up is real and worth naming.** A compromised build tool runs on CI runners and
on the laptops, with the repository checked out and, on the server laptop, next to credentials.
`--omit=dev` means an advisory there no longer blocks a merge. The mitigation is that it is still
reported on every run, in a step that marks the job, rather than discovered later — and the
reason this is an acceptable trade rather than a comfortable one is that the alternative on
2026-10-04 was a repository that could not merge anything at all.

**A yellow job is now a thing to read rather than ignore.** If the second step starts failing for
a reason that is not a glob matcher — a postinstall script, a compiler, a test runner — that is
worth acting on, and nothing will force the issue. That is the weakness this ADR accepts.

**`npm audit --audit-level=high`, unqualified, is no longer the command that must pass.** Anything
asserting the old single step — a Ticket's Acceptance Criteria, a local habit, a future
workflow — should say `npm audit --omit=dev --audit-level=high` for the gate. The tickets written
before this ADR all name the old form; they are not wrong about the intent, only about the
spelling.
