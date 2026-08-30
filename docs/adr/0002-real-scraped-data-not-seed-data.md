---
status: accepted
---

# Data comes from real scraping, not seed fixtures, and the scraper is in auto-merge scope

Rolodeck itself has left "where does the startup data actually come from" deliberately
unresolved, calling it the single biggest risk in that product. This repo does not inherit
that caution: Jack asked explicitly for real data over seed fixtures, and for the scraper
Tickets to be in auto-merge scope like everything else here, accepting the risk of an
unreviewed agent choosing sources and writing scraping code against real external sites
overnight.

Every scraped field is still parsed through a Zod schema at the boundary and tagged with
`provenance: scraped`, per this repo's `CONTEXT.md` and matching rolodeck's own rule; a
site that changes shape must fail loudly rather than propagate `undefined` into a Profile.

## Considered Options

**Hand-compiled seed dataset instead of a live scraper.** Zero scraping infrastructure,
zero ToS or rate-limit exposure, reaches "done" without depending on how cooperative any
external site turns out to be. Rejected: Jack wants to see how the harness handles a
genuinely open-ended, judgement-heavy Ticket run unattended, and a seed file sidesteps
exactly the kind of ambiguity that's the actual point of the test.

**Real scraper, but excluded from auto-merge.** Keeps the highest-blast-radius code
(fetching and parsing real external content) behind a human review while leaving
everything else auto-merged. Rejected, explicitly: Jack chose full auto-merge scope
including the scraper, to see the system run with no exceptions carved out.

## Consequences

If the chosen sources turn out to be scraping-hostile or ToS-restrictive, the Ticket
sequence includes a fallback to hand-written seed data covering the same schema, so the
rest of the product isn't blocked on the scraper succeeding.
