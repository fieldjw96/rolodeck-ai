---
status: accepted
amends: 0015
---

# Launch HN is read as a widening Hacker News search, not a feed

Ticket #220 removed Techmeme from `NEWS_FEEDS` — on 2026-10-24 none of its 15 articles matched
any of 8 Kept Company Profiles, because it carries about fifteen stories a day about the
largest companies in technology, and a pre-seed Bay Area startup is never in it — and added
Launch HN beside the feeds. Launch HN is where Y Combinator companies announce themselves on
Hacker News: about 2.5 posts a week, and every one of the 40 posts between 2026-07-01 and
2026-10-21 was an early-stage YC startup.

This records why Launch HN is not one more entry in `NEWS_FEEDS`, as the Ticket asked to check.

## Why it is not a feed

`NEWS_FEEDS` and `feeds.ts` exist for one shape: an RSS 2.0 document a publisher serves, read
with `feed-fetch.ts`, parsed with `parseNewsFeed`. Launch HN is not that document. It is read
through `hn.algolia.com/api/v1/search_by_date`, the same keyless Algolia Hacker News Search API
the history search (ADR 0018) and the Show HN Source already depend on, with the same
`User-Agent` and the same one-request-a-second limit — `lib/news/history-search-fetch.ts`'s
client, unmodified, so `lib/ingest/boundaries.test.ts` needs no new entry.

So `lib/news/launch-hn.ts` is a third module beside `feeds.ts` and `history-search.ts`:
parsing only, offline-tested against a real capture under `db/fixtures/`, with the fetch done
by whatever module already owns the host it reads.

## Why its window is not "today", and carries no new state

A feed is read once a run and gives today's stories; a Company Profile's history search runs
once ever, per `news_profile_coverage`. Launch HN is neither. It is read every run, like a
feed, but a feed's "since the last time this ran" is implicit — the publisher only ever serves
what is current. Algolia's search does not forget, so Launch HN must say how far back to ask,
or it re-reads the same handful of posts forever.

The window is the later of two things: since the previous run that successfully read Launch
HN, or the last seven days, whichever is longer — so a run that follows closely on the last one
asks a short, cheap question, and a run after an outage or a quiet patch still catches
everything.

docs/adr/0022 already decided, for the history search, that this kind of state is not worth a
migration: `news_profile_coverage` is read, not inferred. Launch HN's "since" is cheaper still
to avoid a table for: every post it stores carries a title beginning `Launch HN:` by
construction, and `news_articles` is unique on `url`. So "the previous successful run" is read
as the newest `publishedAt` already stored under that prefix — `readLatestLaunchHnPublishedAt`
in `db/news.ts` — floored to seven days ago when there is none, or when the floor is further
back. A run that found nothing new left that boundary where it was, which is correct: nothing
was missed by going no further back than the newest post already known.

## Why it is scored like a feed, not like a search

ADR 0018's history search runs once per Company Profile, so a result is scored against the one
Profile it was searched for and nothing else. Launch HN's query names no company — it is
"Launch HN", a format, not a subject — so a hit is exactly as unattributed as a feed article,
and the Ticket said to score it the same way: against every Company Profile in the Catalogue,
through the same `fromFeeds` path a feed article goes through, stored in `news_articles`
alongside them. A Launch HN post about a company not yet in the Catalogue is stored and scored
at zero against everyone, exactly as a feed article is, and is there to be matched against the
next Company Profile that arrives, per docs/adr/0022.

## Why its `url` and `source_name` are fixed, unlike a search result's

docs/adr/0018 made a search result's `source_name` the linked site's host for a link post,
because a search result finds other people's writing and a feed item's own permalink is not
what was published. A Launch HN post is the opposite: the company's own introduction of itself,
and the discussion under it — the comments asking what it costs, what it replaces, whether it
is any good — is the thing worth linking to, not whichever landing page the post happened to
link out to. So every Launch HN post is stored as its Hacker News item
(`news.ycombinator.com/item?id=…`), `source_name` always `Hacker News`, whether or not the hit
itself carried a link.

## Consequences

**A Launch HN failure, alone, never fails a run.** `newsRunFailures` gained no new rule for it:
a request that cannot be fetched or that changes shape is named in the run's output, same as a
feed or a search that failed, but the run's exit code still follows the two rules that existed
before this Ticket — not one feed read, or a Company Profile to search for and not one search
that succeeded. With `NEWS_FEEDS` now empty, a run that cannot read Launch HN and has no other
feed exits zero, naming the failure in its log. Giving Launch HN's own failure a third rule is
a deliberate non-decision here, left for whoever next has reason to measure how often it
actually fails silently this way.

## Considered Options

**A fourth `NEWS_FEEDS` entry whose "feed" is an Algolia query wrapped to look like RSS.**
Rejected: it would make `parseNewsFeed` the lie, pretending an XML document arrived when it did
not, to satisfy a type rather than a fact.

**Tracking "the previous run" with a new table or column**, as `news_profile_coverage` does for
the history search. Rejected on the same grounds docs/adr/0022 rejected it for a different
reason: there is already a fact in `news_articles` — the newest stored post's `publishedAt` —
that answers the same question, and a second place to keep an answer already on file is a
place they can disagree.
