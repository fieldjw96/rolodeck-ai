# Rolodeck AI

A fully AI-authored build of the rolodeck concept: a swipeable deck of Bay Area startup
profiles. This repo exists as a stress test of the agent-harness dispatcher running
unattended with auto-merge on, not as a separate product decision from rolodeck itself.

This repo runs on agent-harness's dispatcher and inherits its vocabulary as-is: Ticket,
Lane, Run, Gate, Bounce, Blocker and Acceptance Criteria are all defined in
`agent-harness/CONTEXT.md` and are not redefined here.

## Language

**Profile**:
One startup's record in the Deck: name, description, sector, stage, and provenance.
_Avoid_: card, entry, listing

**Deck**:
The ordered set of Profiles a session works through.
_Avoid_: feed, list, queue

**Keep** / **Pass**:
The two swipe actions on a Profile. Keep marks it worth a conversation; Pass dismisses it
from the current Deck without deleting the Profile.
_Avoid_: like/dislike, save/skip, accept/reject

**Provenance**:
Where a Profile field's value came from: `scraped`, `enriched`, or `jack`. Carried per
field, not per Profile, matching rolodeck's own rule so the two repos stay comparable.
_Avoid_: source, origin
