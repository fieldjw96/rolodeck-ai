---
status: superseded
superseded-by: 0012
---

# This repo runs unattended, with auto-merge on, by explicit request

Every Ticket in this repo merges itself once it has an approving second-agent review and a
green build, with nobody looking at the pull request first. This is deliberate and
requested, not a gap: Jack asked to see the dispatcher run "in full go mode" on a
disposable repo before deciding whether any of this belongs on rolodeck, which still
merges by hand. See `agent-harness` ADR 0004 (the default) and ADR 0009 (this repo's
opt-out of it).

## Consequences

A bad Run can ship a bad merge here with nobody noticing until morning. That is the point
of tonight's test. Nothing about this repo's own risk tolerance should be read across to
rolodeck; the two are intentionally on different settings.
