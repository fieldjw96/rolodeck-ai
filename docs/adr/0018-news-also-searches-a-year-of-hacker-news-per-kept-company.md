---
status: accepted
amends: 0015
---

# News also searches a year of Hacker News for each Kept company

This amends docs/adr/0015. It does not supersede it.

ADR 0015 decided that News reads publisher feeds, and it gave a reason that turned out to be
wrong: "searching by company name needs a search provider, and the keyless ones are closed."
It checked GNews, Google News RSS and the publishers' own search pages. It did not check the one
keyless search this repo already depended on, Algolia's Hacker News Search API, which the Show HN
Source has read since `scripts/fetch-show-hn.ts` was written. So the claim is wrong and the
decision is not. Everything else in ADR 0015 stands exactly as written: the feed path, `NEWS_FEEDS`,
the one-request-per-feed cost, and its reasons for rejecting GNews, Google News and publisher
search. ADR 0010's design is untouched: every candidate is stored with a `confidence` from
`scoreNewsMatch`, and `NEWS_DISPLAY_THRESHOLD` decides what is shown, on read.

## Why

On 2026-09-20 News scored 240 candidates against 16 Kept Company Profiles and not one reached
the threshold. Neither cause was the matcher. The only feed is Techmeme's, fifteen articles a day
about the largest companies in technology, and a pre-seed Bay Area startup is never in it. And a
feed carries only what published today, so an article about a Kept company from March could never
be reached: the Watchlist could answer "was it in today's headlines" and never "what has been said
about this company". Jack asked for both halves: a year of back coverage for the companies he has
Kept, and new articles as they land.

## The decision

A News run keeps its feed path and adds a second beside it. For each Kept Company Profile it runs
two queries against `hn.algolia.com/api/v1/search`, the relevance-ranked sibling of the endpoint
the Show HN Source reads:

- **The company's own site**: the domain of its `website`, searched in the story's url, and kept
  only when the story's host is that domain or a subdomain of it.
- **Its name, as an exact phrase in the title**, with typo tolerance off, and discarded whole when
  it answers with more than ten titles, which is a name too common to search by.

Both are stories only, the last twelve months, and capped at fifty hits. `lib/news/history-search.ts`
records, in its header, what each constraint was measured to do, including the worst case: a bare
search for `Versive` returns tens of thousands of hits, and the constrained one returns none.

Each result is scored against the Company Profile it was searched for and against no other. That
is the difference from the feed path, which scores every article against every Kept Profile
because it does not know who an article is about. A search does know, so a targeted result is
about the company it was searched for or it is about nothing.

- **Fetching is one more module.** `lib/news/history-search-fetch.ts` sends the same honest
  `User-Agent` as the feeds, at one request a second, and `lib/ingest/boundaries.test.ts` names it.
  A run makes at most two requests per Kept company, so sixteen companies take about half a
  minute.
- **Failure is judged per path.** A response that has changed shape is a rejection naming the
  field, and costs that one company. A run whose every search failed exits non-zero even if every
  feed was read, and a run whose every feed failed still exits non-zero even if the searches
  succeeded. The output names which half failed.
- **The run reports the distribution of confidence scores for each path**, every score with its
  count, so "nothing cleared the threshold" can be told apart from "there was nothing to clear it".
- **No new state.** `news_items` already has a unique index on `(profile_id, url)`, so a search
  re-run stores nothing twice. No "last searched" marker is kept: two requests per Kept company per
  day is not a cost worth new schema to avoid. No migration.
- **No new credential.** The API is keyless, and `readKeptCompaniesForNews` reads `website` from
  `profiles`, which the ingest role could already select.

## Considered Options

**An unconstrained search by company name.** Rejected on measurement. Company names are
dictionary words, and typo tolerance widens them further: `Versive` matches "version".

**Only the site query.** Precise, but finds only what a company wrote about itself. The title
query is what finds other people writing about it, such as Tailscale's post about Blacksmith.

**Keeping the title results of a common name and trusting the matcher.** Rejected because the
matcher cannot tell a namesake from the company by a headline, which ADR 0010 said first. On
2026-09-20, "AI Darwin Awards" scored 0.6 against a Kept AI company named Darwin and would have
been shown.

**Changing `NEWS_DISPLAY_THRESHOLD` or `scoreNewsMatch` in the same change.** Rejected. ADR 0010
built the threshold to be retuned against evidence, and this change is what produces the first
real evidence. Changing both at once would mean nobody could tell which one did the work.

## Consequences

**Coverage is Hacker News's.** An article about a Kept company that nobody submitted to Hacker
News is still invisible. ADR 0015's mitigation still applies to the feed path, and a second search
host would be a further amendment.

**A company's own writing mostly scores low.** A post on a company's blog rarely puts the company's
name in its headline, and `scoreNewsMatch` needs a mention to score anything. Those rows are stored
with their scores, as every candidate is, and are the evidence a retune of the matcher would start
from. This ADR does not retune it.

**`source_name` is the linked site's host** for a link post, since that is who published it, and
"Hacker News" for a text post, whose url is its Hacker News item. ADR 0015 set `source_name` to the
feed's publication because a feed item links to the feed's own permalink. A search result links to
the article itself, so the article's host is the honest name for it.
