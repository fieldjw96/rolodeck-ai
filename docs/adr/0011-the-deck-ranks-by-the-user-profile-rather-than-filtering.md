---
status: accepted
---

# The Deck ranks by the User Profile rather than filtering, with excluded Sectors the one exception

Until this decision the Deck dealt every Company Profile newest-first, which is how a company
with a $50M Series A came to the top of a Deck whose brief is Bay Area startups. The User
Profile exists to fix that, and the obvious way to use it is as a filter: show only the
Sectors, Stages and area the owner stated. The Deck does not do that. It **ranks**.

`readDeckPage` in `db/deck.ts` gives every Company Profile a score from the owner's User
Profile and deals the highest scores first:

- its `sector` is one of the User Profile's `sectors`: +4
- its `stage` is one of the User Profile's `stages`: +2
- its `location` names a city in the User Profile's `area`: +1

The weights are `DECK_RANK_WEIGHTS`, a named constant beside the query and nowhere else. They
are powers of two, so no two different sets of matches ever produce the same score: a Sector
match outranks a Stage match and an area match together, and a Stage match outranks an area
match alone. Sector comes first because it is the most discriminating thing the owner states,
one of twelve. Area comes last because it is the least: every Source already leans Bay Area,
so an area match mostly separates the few off-brief rows from the rest, and the bottom of the
Deck is where those belong.

Ties break on `created_at` descending, then `id` descending, so the order is total.

An owner who has never saved a User Profile has stated nothing, so every row scores 0, which is
exactly the old newest-first Deck. That includes the area. `readUserProfile` answers a
never-saved owner with `area` set to "Bay Area", but that is the settings form's starting
value, not something the owner said, so the Deck reads `readSavedUserProfile` instead and
ranks on no area until one is saved. Every empty preference compiles to `false` in the score,
so beyond that one default there is no branch in the query, and none in its caller.

## Why every company still appears

A filter is a promise that you know what you want. A deck is the opposite promise. The point
of swiping through startups is to meet the one you would never have thought to ask for, and a
User Profile that stated `ai-ml` would, as a filter, guarantee the owner never sees the
`climate-energy` company that turns out to be the interesting one. So a Company Profile
matching none of the stated preferences is not dropped, it is dealt last. That is the purpose
of the product, not a tolerated side effect of an imprecise ranking.

It also makes a wrong User Profile cheap. A Sector left out by mistake pushes companies down,
where they are still found by swiping on, rather than silently removing them.

## The one exception: `excluded_sectors`

A Company Profile whose `sector` is in the User Profile's `excluded_sectors` is omitted from
the Deck entirely, not merely sorted last. Stating an exclusion is the owner saying the
opposite of "surprise me": they have already seen that Sector and do not want it. Ranking
it last would still deal it, one card at a time, to someone who said no. This is the only
thing in the User Profile that removes a row, and it removes rows only by Sector.

Already-swiped Company Profiles stay excluded as they were; that is a decision about a row,
not a preference.

## Considered Options

**Filter on stated Sectors and Stages.** Rejected, for the reason above.

**Score in TypeScript after fetching the owner's whole Deck.** Simple to read, and the
location rule already exists in TypeScript as `isBayArea`. Rejected: it reads every row on
every page, and paging a sort done outside the database means holding the whole sorted list
somewhere between requests. The score is a SQL expression instead, and the city list behind
`isBayArea` is passed into it as parameters through `citiesInArea`, with a test holding the
SQL and the TypeScript to the same answer.

**Equal weights.** Rejected: a row matching Sector alone would tie with a row matching area
alone, and the tie would be broken by age, which says nothing about what the owner stated.

## Consequences

The cursor carries the score. Keyset paging over a computed order only produces each row
exactly once if every column of the order is in the cursor, so a cursor is now
`(score, created_at, id)` and the page after it is the rows strictly below that tuple. A
cursor issued before this change has no score and is refused with a 422, the same as any
cursor the endpoint did not issue; the Deck starts again from the top.

A cursor's score means something only under the User Profile it was computed from. If the
owner saves a different User Profile between two pages, the next page resumes from a tuple
the new scores no longer agree with, and a row can repeat or be skipped. Re-ranking mid-session
is out of scope; the Deck loads its first page afresh whenever it is opened, which is when a
new User Profile takes effect.

The `(owner_id, created_at, id)` index no longer carries the whole order, since no index can
hold a score that depends on request parameters. It still narrows the scan to one owner's
rows, and at single-player volume sorting those is cheap.
