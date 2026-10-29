---
status: accepted
---

# A company found by two Sources is collapsed where it is read, not where it is written

A company two Sources both found is two Company Profiles. `(source, name_key)` is the Catalogue's
key per docs/adr/0008, so the SEC filing index and Show HN each get their own row for Sprocket,
and docs/adr/0008 names the cost plainly: two cards in the Deck until some later Ticket takes it
on. This is that Ticket, and it takes on only the cost. The rows are not merged, no column is
added and no migration is written; entity resolution — which Source's `sector` wins, whether two
Sources agreeing on a name agree on a company — is still deferred, exactly as docs/adr/0008 left
it.

So the three surfaces a reader meets a company on collapse its rows on the way out. "Siblings"
is the word for the rows sharing one `name_key`. The Deck ranks the siblings a Sector exclusion
leaves and deals the first by its own order — score, then `created_at`, then `id` — so the card
dealt is the best-ranked account of the company rather than whichever Source ran last. A Keep or
a Pass on any sibling answers for all of them, which it has to: a reader who has judged a company
has judged it, and the point of this is to stop asking twice. The Watchlist and the News page
show the sibling the reader's newest decision about that company was recorded against, where that
decision was a Keep.

**The newest decision across the siblings is the one that counts.** That rule is what makes the
collapse work on rows written before it existed, and nothing else here does. While the Deck dealt
both siblings a reader could Keep both, or Keep one and Pass the other, and those rows are still
there: no migration is reconciling them. Under this rule a Watchlist entry's Pass covers the
sibling Kept last week — the Pass is newer, so the older Keep is not the decision that counts,
and the company leaves the Watchlist and the News page together. It also extends `recordSwipe`'s
own existing rule, that swiping a Company Profile again is a correction and the newer decision
wins, from one row to one company.

An article attributed to two siblings is one article on the page. `news_items` is unique on
`(profile_id, url)`, so each sibling carries its own Attribution for the same piece; the group
holds the first by the order the page is already in and drops the rest. The two differ at most in
`confidence`, which is the matcher's view of one Source's row rather than a fact about the
company.

## Considered Options

**Collapse on write: a swipe writes one row per sibling.** The read paths get simpler — the Deck's
existing single-row `not exists` would already be right — and the stored state says plainly what
the reader decided. Rejected, because it cannot answer for the rows already written. A reader who
Kept both siblings last week has two Keeps and nothing is going to fan out retrospectively, so
`readKeptProfiles` would still need to collapse on read to show one entry, and the Deck would
still need to choose which sibling to deal. Having chosen read-side rules anyway, a write-side
fan-out would be a second mechanism saying the same thing, with the failure mode docs/adr/0008
names for deduplicating in TypeScript: the half the database does not know about is the half that
stops being true. It also multiplies rows per swipe, and makes `recordSwipe`'s answer — one
`profile_id`, one decision — a lie about what it did.

**Merge the rows.** The honest fix, and out of scope: it needs a rule for which Source's value
wins each field and a record of what was overwritten, which is the decision docs/adr/0008
deliberately did not take inside "write the row".

**Deal both cards and hide the second one in the client.** Rejected: pagination is server-side, so
a page of twenty could arrive as nineteen cards, and the Deck would be exhausted a page early
with no way for the client to ask for the difference. Whether a company has been dealt is also
not something a session should have to remember.

**A Sector exclusion that takes out the best-ranked sibling takes out the company.** Tempting as
the simpler rule — rank the siblings first, then filter — and wrong twice over. The excluded row
is no part of this reader's Deck at all per docs/adr/0011, so it cannot speak for the company; and
the two rows can disagree about `sector`, which is precisely the disagreement nothing here is
qualified to resolve. The company is dealt under the Source that is left.

## Consequences

The collapse is written against `userId` in each query, as the swipe clauses already were, so RLS
stays a backstop and never the only control (CLAUDE.md). It costs the Deck a subquery: the window
that picks a sibling has to see the same score the page is ordered by, so the ranking happens
inside and the cursor pages over the winners alone. Its `(score, created_at, id)` is as unique
among them as it was over the whole Catalogue, so paging still deals every eligible company
exactly once.

`npm run measure:profile-duplicates` sizes what this is worth against a real database: how many
`name_key`s carry more than one Source's row, and which companies are the worst of it.

The Diary needed nothing. It already named a company once, by selecting `distinct` names of the
Kept companies attending an Event.

Nothing about ingest changes. Two Sources still write two rows, `profiles` still holds both, and
the known limitation in `scripts/ingest-ycombinator.ts` is now about the Catalogue rather than
about the Deck.
