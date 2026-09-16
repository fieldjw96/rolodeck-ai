---
status: accepted
---

# A stage that cannot be derived is recorded as `not-stated`, not a reason to discard the company

This amends docs/adr/0007 and docs/adr/0009. It supersedes neither.

Neither derivation rule changes. adr/0007 still derives `stage` from team size, against the same
bands, attributed `enriched`. adr/0009 still reads a round a Form D names, attributed `scraped`,
and still refuses to read a SAFE as a round: a SAFE says how money is taken, not what stage a
company is at, and that reasoning stands exactly as written. What changes is only the
consequence of both rules failing. Before this, a candidate with no stage to derive was rejected
naming `stage`. Now it is kept, and its stage is `not-stated`.

`not-stated` is attributed `enriched`, never `scraped`. The Source did not state it; the pipeline
wrote the marker. Under CONTEXT.md's definitions that is exactly what `enriched` means.

## Why

The SEC Form D Source is the only Source that states "this company is raising now" as a fact,
and on 2026-09-16 it wrote nothing and failed: 100 filings fetched, 2 outside California, 98
rejected on `stage`. A sample of 25 Californian Form D filings from the week to 2026-09-15 shows
why. 15 were `Pooled Investment Fund`, 2 `Investing`, 1 `Commercial` and 1 `Residential`; 6 were
operating companies, and every one of those that named a security named a SAFE. adr/0009's
refusal to read a SAFE as a round was right, and it meant every real company on the Source was
discarded for want of one derived field.

`sector` met this problem first and solved it. `SECTOR_VALUES` carries `other` because ingest must
be able to place every row, and a visible `other` is honest where a silent mis-map is not.
`not-stated` is the same answer for `stage`: visible, honest, and not a guess.

## The funds, which the stage rule had been excluding by accident

Roughly three quarters of that sample is not a company at all, and until now it was kept out of
the Deck only as a side effect of the stage rejection. Removing that rejection without replacing
it would fill the Deck with venture funds and apartment buildings. So `lib/ingest/sec-form-d.ts`
now rejects, naming `industryGroup`, a filing whose industry group is an entity that holds assets
rather than building a product: pooled investment funds, investing vehicles, and every Form D
real-estate group. The list is `ASSET_HOLDING_INDUSTRY_GROUPS`, and the rule is written beside it
so that a group not on it is judged against the rule, not by resemblance to the list.

## Considered Options

**Make `stage` optional.** adr/0007 rejected this and the reason holds: it widens a schema every
ingest path shares, and makes ranking on stage a query over a nullable column. A closed value
keeps the column non-null and the Deck's `inArray` unchanged.

**Guess a stage from something else on a Form D** — the offering size, the amount sold, the
number of related persons, or a SAFE read as pre-seed. adr/0009 rejected each of these with
reasons that still hold, and this decision exists so that no such guess is needed.

**Keep rejecting, and only add the fund filter.** Honest and useless, in adr/0007's own words: the
Source would still write nothing, because the operating companies left after the filter are the
ones naming SAFEs.

## Consequences

`not-stated` is a Company Profile's stage and never a preference. `db/user-profile-input.ts`
rejects it in `stages`, and the settings page does not offer it: preferring it would rank
companies by what ingest failed to learn. `STATED_STAGE_VALUES` is the list an owner chooses
from; `STAGE_VALUES` is that plus `not-stated`, and its order carries no meaning.

The Deck is not special-cased. A `not-stated` Profile matches no stage preference because none can
name it, scores 0 on the stage component, and is still dealt, per docs/adr/0011.

The card shows `Not stated`, set apart from a stated value, rather than the slug.

No migration. `profiles.stage` is `text not null` with no check constraint, so the vocabulary is
enforced in Zod alone, as it was before. Nothing in `profiles` carries `not-stated` until the next
ingest run writes one.

`db/fixtures/sec-form-d-krina-ai.xml` and `db/fixtures/yc-lawdingo.html`, kept in the suite to
exercise the stage rejection, now exercise `not-stated` instead.
