---
status: accepted
---

# `stage` is a stated round where a filing gives one, and the headcount band only where none does

docs/adr/0007 decided `stage` for a Y Combinator page, where no funding round is stated
anywhere, by deriving it from team size and attributing it `enriched`. It said plainly that
headcount is a poor proxy, and that a later Ticket finding a real funding source could replace
the one field.

An SEC Form D is that source. Its "type of security" free text is where an issuer writes what
it is selling, and issuers write round names there: "Series Seed Preferred Stock", "Senior
Series B Preferred Stock", "Shares of Series A Preferred Stock". That is the company stating
its own round in a document it signed, so a `stage` read from it is attributed `scraped`.

This changes what `stage` means rather than only where it comes from, which is why it is
written down. Before this Ticket every `stage` in `profiles` was a headcount band wearing a
funding label. Now some are the round the company actually raised and some are still the band,
and the two are told apart by `attribution.stage.provenance` and nothing else. Any analysis
that reads the column without reading the provenance beside it is now wrong in a way it was not
before — which is exactly the price of the field getting more truthful for some rows and not
others, and exactly what per-field provenance exists to make checkable.

A Form D carries no headcount at all, so on this Source adr/0007's derivation has no input of
its own. `parseFormDFiling` takes an optional `teamSize` for a pipeline that knows one from
elsewhere, and a filing that names no round with no headcount to fall back on is rejected
naming `stage` — the same rule adr/0007 sets for a YC page with no team size. In practice that
rejects the pooled investment funds and debt offerings that make up most of EDGAR's Californian
Form D traffic, which is the right answer: an LP selling fund interests is not a company at a
funding stage.

## Considered Options

**Attribute a stated round `enriched` too, so the column stays uniform.** Tempting, because
then no reader has to know about this decision at all. Rejected: it is a lie in the safer
direction, and CONTEXT.md defines `enriched` as a value the pipeline produced. "Series B
Preferred Stock" is a value the issuer produced and swore to. Flattening the distinction throws
away the only thing that makes a Form D better than a headcount guess.

**Map the round name onto a stage from more of the filing than one field.** A Form D has
several free-text boxes — `clarificationOfResponse` under the business-combination and
sales-amount questions — and issuers do sometimes name a round in them. Rejected: reading every
box is a fishing expedition whose false-positive rate nobody can state, and a stage attributed
`scraped` has to come from a field that means what we are reading it as.
`typesOfSecuritiesOffered.descriptionOfOtherType` is _the_ field for "what is being sold". If a
later Ticket wants more, it should widen this deliberately and say what it widened.

**Treat a SAFE as a stage.** "Simple Agreement for Future Equity" is the most common answer in
that box for early-stage Californian issuers, and it is tempting to read it as pre-seed or
seed. Rejected: a SAFE says how the money is being taken, not what stage the company is at.
Companies raise on SAFEs at pre-seed, at seed, and as a bridge after a Series A. Mapping it
would put a guess under a `scraped` tag, which is the one thing adr/0007 was written to prevent.

**Derive the fallback stage from the amount raised instead of headcount.** A Form D does state
the offering size, and it correlates with stage better than nothing. Rejected here because it
would be a _second_ proxy with its own bands, arrived at by an agent overnight with no evidence
for where the boundaries go, sitting beside adr/0007's in the same column and indistinguishable
from it. One admitted-poor proxy is a known quantity; two are folklore.

**Take the earliest round when a filing names several.** Issuers really do file one Form D
covering a "parallel Seed 3 + Series A Preferred Stock" offering. The most advanced round named
wins instead: a company selling Series A preferred is at Series A whatever else is in the same
raise.

## Consequences

`profiles.stage` is no longer uniform in kind, and `profiles.provenance->>'stage'` is the only
way to tell which kind a given row is. The Deck does not currently distinguish them, and does
not have to — a stage is a stage to a swipe — but anything that ever aggregates over the column
must read the provenance too.

A company can appear twice in the Deck, once from YC with an `enriched` stage and once from
`sec-form-d` with a `scraped` one, because adr/0008 makes the Source part of a Profile's
identity. That is adr/0008's accepted cost, not a new one, and this decision makes the two rows
disagree in a legible way rather than a silent one.

`description` on a Form D Profile is attributed `enriched`, which is the same rule applied to a
different field: a Form D states facts and writes no prose, so the sentence a Profile carries is
composed by this pipeline out of the industry, the location, the amounts and the date of first
sale. Every ingredient is scraped; the sentence is not, and the filing never said it.

`db/fixtures/sec-form-d-krina-ai.xml` is a real Californian filing that names no round, and is in
the suite precisely so the rejection and the adr/0007 fallback both stay exercised.
