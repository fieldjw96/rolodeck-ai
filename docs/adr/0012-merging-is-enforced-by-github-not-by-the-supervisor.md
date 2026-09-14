---
status: accepted
supersedes: 0001
---

# Merging is enforced by GitHub, and three paths still need Jack

Supersedes ADR 0001, which said this repo merges every Ticket unattended on an approving
review and a green build. That decision was made for a disposable repo, as a test of whether
"full go mode" belonged on rolodeck at all, and it delegated the enforcing to the
dispatcher's own code via `agent-harness` ADRs 0004 and 0009. Both of those premises have
since gone: `agent-harness` is archived, and this repo is deployed at
`rolodeck-ai.vercel.app` rather than disposable.

Auto-merge stays. What changes is who enforces it and what it excludes.

## The decision

**GitHub enforces the merge rules, not the supervisor.** A branch ruleset on `main` requires
every check green, an approving review from the Gate, and the branch to be up to date with
`main` before it can merge. `foreman` deliberately owns none of this: its predecessor's
merge logic is the part that failed most often, and a rule GitHub enforces cannot be got
wrong by a bug in ours.

**The branch must be up to date with `main`.** This is the rule ADR 0001 lacked and the
reason it needed replacing. Ticket #120 was reviewed, approved and green; Ticket #50 then
merged; thirteen tests failed against the new `main` on Sources #120 had never been told
about. Green checks describe the world when they ran, and nothing before now re-asked.

**Three paths still require Jack's own approval**, listed in `.github/CODEOWNERS`:

- `.github/workflows/` is the Gate itself. A Run that weakened `claude-review.yml` or
  `ci.yml` would face no reviewer on the pull request after it, and the change would be in
  force for every Run that followed.
- `db/migrations/` is the least reversible thing here. Reverting a commit does not unmake a
  schema change. PR #127 is the case in point: six green checks, and the Gate caught a
  backfill regex that truncated any city name containing a period, writing an invented
  location with `scraped` provenance in contradiction of ADR 0002.
- `.github/CODEOWNERS` is this rule, and it must not be editable by what it constrains.

## Consequences

Most work merges with nobody watching, which is the point and is unchanged from ADR 0001.
Schema changes and changes to the review machinery now wait for Jack, which makes this repo
slower than ADR 0001 promised in exactly the two places where being slower is cheap and
being wrong is not.

The Gate's approval must be a verdict GitHub will accept as a review. If it turns out that
approvals from `github-actions` do not satisfy a required review, the fix is to make the
`review` check fail on `CHANGES_REQUESTED` rather than pass, and to require that check
instead of the approval. That is a workflow change and so itself needs Jack, which is the
rule behaving correctly rather than an obstacle to it.

ADR 0001's closing line said nothing about this repo's risk tolerance should be read across
to `rolodeck`. That still holds, and `rolodeck` remains an empty repo that is not the
product.
