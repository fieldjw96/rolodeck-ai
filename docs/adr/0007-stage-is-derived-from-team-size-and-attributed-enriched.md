---
status: accepted
---

# `stage` is derived from team size and attributed `enriched`, not `scraped`

_Amended by docs/adr/0015: the derivation below stands, but a page with no usable team size is
now kept with its stage `not-stated` rather than rejected naming `stage`._

A Y Combinator company page carries name, description, industries, website, batch, founding
year, status, headcount and founders. It does not carry a funding round, and nothing on the
page is one. `profileInputSchema` requires `stage`, so ingesting YC pages at all means
deciding where that value comes from.

It is derived from team size, against the conventional headcount bands — 500 and up is
`growth`, 100 is `series-b-plus`, 25 is `series-a`, 5 is `seed`, 1 is `pre-seed` — and
attributed `enriched` rather than `scraped`. That word already exists in `CONTEXT.md` for
exactly this: a value the pipeline produced rather than one a source stated. Provenance is
per field, so a Profile can say its `stage` was inferred while its `sector` was read
straight off the page, and a later Ticket that finds a real funding source can replace the
one field and nothing else.

Headcount is a proxy and will be wrong for some companies — a well-funded eight-person
research team reads as `seed` here. It is used because it is the only signal on the page
that moves with stage at all, and because being visibly wrong under an `enriched` tag is
better than being invisibly wrong under a `scraped` one.

A page with no usable team size yields no stage, and the candidate is rejected naming
`stage`. That is the same rule CLAUDE.md sets for every other field: fail loudly at the
edge rather than propagate a value nobody stands behind.

## Considered Options

**Read `stage` off the page's status field.** YC states `Active`, `Acquired`, `Public` or
`Inactive`. Rejected: that is an outcome, not a stage. Wufoo was acquired with eleven
people and Stripe is active with seven thousand; mapping either onto a funding round says
something the page did not.

**Make `stage` optional in `profileInputSchema`.** Rejected: it widens a schema shared by
every ingest path, including the seed loader and future enrichment, to accommodate one
source's gap, and it makes "the Deck filters on stage" a query against a nullable column.
The gap belongs in the parser that has it.

**Reject every YC page for want of a stage.** Rejected: it is honest and useless. It would
leave the source with a hundred per cent rejection rate and no Profiles, which is not a
loud failure so much as no pipeline.

**Fetch stage from a funding database and join it in.** Rejected here, not on the merits:
it is a second external source with its own boundary, its own rate limits and its own
Ticket. Nothing in this decision blocks it, and the `enriched` tag is what makes swapping
in a better answer a change to one field rather than a migration.

## Consequences

`stage` on a YC-sourced Profile is a headcount band wearing a funding label, and any
analysis that treats it as a funding fact is wrong. The per-field attribution is what makes
that checkable rather than folklore: `attribution.stage.provenance` is `enriched` on every
Profile this parser produces.

Companies with a team size of zero or none at all — dead startups, mostly — are rejected
rather than ingested. `db/fixtures/yc-lawdingo.html` is a real captured example, and is in
the suite precisely so the rejection stays exercised.
