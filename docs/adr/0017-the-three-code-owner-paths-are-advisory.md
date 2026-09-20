---
status: accepted
amends: 0012
---

# The three code-owner paths are advisory, because they cannot be anything else

ADR 0012 decided that three paths "still require Jack's own approval": `.github/workflows/`,
`db/migrations/` and `.github/CODEOWNERS`. That part of it was never true in practice and
cannot be made true as this repo is set up. This ADR replaces that one decision. Everything
else in ADR 0012 stands, including the ruleset enforcing the merge rules and the requirement
that a branch be up to date with `main`, which was the reason ADR 0012 was written at all.

## Why it cannot hold

Two independent reasons, either of which would be enough on its own.

**The ruleset lets it through.** The branch ruleset on `main` has exactly one bypass actor:
the repository admin role, with bypass mode `always`. Runs act as Jack, who holds that role,
so every rule on that list is advisory to them, not only the code-owner one.

**The review it asks for is impossible, not merely absent.** GitHub does not let anyone approve
their own pull request. A Run's pull request is authored by Jack, because the `gh` login the
Runs use is his. So Jack's code-owner approval on a Run's pull request cannot be given at all.
Removing the bypass would not fix this; it would deadlock every pull request touching one of
these paths, with no legal way to merge it.

PR #147 is the evidence rather than the theory. It changed `.github/workflows/ingest-run.yml`,
was approved by `github-actions`, and merged ten seconds later without Jack seeing it, with the
merge attributed to him.

## The option that was considered

Giving the Runs a GitHub identity of their own — a machine account, which GitHub's terms permit
alongside a personal one, and which costs nothing on a Pro private repository. Then a Run's
pull request is authored by somebody who is not Jack, his code-owner approval becomes both
possible and meaningful, and `author` against `mergedBy` finally distinguishes his work from a
Run's.

Rejected on 2026-09-18, deliberately and by Jack: this is a single-player repo, every commit in
it is his either way, and the attribution problem it would solve is one he does not have.

## What replaces the decision

The three paths stay listed in `.github/CODEOWNERS`, and the file keeps its explanation of why
each one is worth care. What changes is the claim about what listing them does. It flags, it
does not gate. A pull request touching one of these paths should say so plainly in its body,
because nothing else will.

## Consequences

**A Run can change the Gate, the schema or this rule without a human seeing it, and that is now
written down rather than assumed away.** The protection against that is the review Gate and the
tests, the same as for every other path, plus whatever attention the flag draws.

`db/migrations/` is the one where this costs the most, because reverting a commit does not
unmake a schema change. Nothing in this ADR makes that safer; it only stops the repo claiming a
safeguard it does not have. If that turns out to be too much risk, the answer is the machine
account above, and this ADR should be superseded rather than quietly worked around.

ADR 0012's own Consequences section anticipated a related failure — that `github-actions`
approvals might not satisfy a required review — and said the fix would be a workflow change,
"which is the rule behaving correctly rather than an obstacle to it". That sentence assumed the
rule worked. It did not, and this ADR is the correction.
