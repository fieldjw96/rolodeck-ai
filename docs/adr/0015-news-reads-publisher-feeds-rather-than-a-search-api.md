---
status: accepted
---

# News reads publisher feeds rather than a search API

This amends docs/adr/0010. It does not supersede it.

Amended by docs/adr/0018: the keyless search this ADR said did not exist does, on the Hacker News
Search API the Show HN Source already reads, and News now also searches it for each Kept company.
The feed path, and the reasons below for rejecting GNews, Google News and publisher search, stand.

ADR 0010 decided two things: how News judges and stores what it finds, and where it finds it.
The first stands exactly as written. Every candidate article is stored in `news_items` with a
`confidence` from `scoreNewsMatch`, including the ones that score zero, and what the owner sees
is decided on read against `NEWS_DISPLAY_THRESHOLD`. The matcher, its weights, the threshold,
`db/news.ts` and the table's columns are unchanged. The second, GNews, is replaced here.

## Why GNews went

GNews needs an API key, and no key was ever issued, so the News Source never ran once. Rather
than get one, Jack's decision is to read the feeds publishers offer for software to read, rather
than go through a keyed search provider.

## Why feeds rather than another search

Searching by company name needs a search provider, and the keyless ones are closed. Checked on
2026-09-16:

- `news.google.com/robots.txt` is `Disallow: /` for `User-agent: *`, with an allowlist that does
  not include `/rss`, and separately names `ClaudeBot`, `anthropic-ai`, `GPTBot`, `CCBot` and
  `PerplexityBot` with `Disallow: /`. Google News RSS is not available to this project, and ADR
  0010 was right to reject it.
- `www.techmeme.com/robots.txt` disallows `/search/`, `/timeline/` and its redirect paths
  (`/r/`, `/r2/`, `/goto/` and the like), and does not disallow `/feed.xml`, which answered 200
  with 15 items. It separately gives `Claude-User` `Allow: /`.
- `techcrunch.com/robots.txt` disallows `/wp-admin/`, `/wp-json/`, `/search/` and `/?s=` for
  `User-agent: *`, and does not disallow `/feed/`, which answered 200 with 20 items. It also
  gives `anthropic-ai`, `ClaudeBot` and `Claude-Web` `Disallow: /`.

The pattern is consistent: search endpoints are closed, syndication feeds are open. A feed is a
document a publisher offers for software to read, which is the same test
`lib/ingest/techmeme-events.ts` already applies to Techmeme's iCalendar feed.

This also inverts the cost. A run makes one request per feed however many companies are Kept,
where GNews needed one request per Kept company against a daily quota.

## The decision

A run fetches every feed in `NEWS_FEEDS` (`lib/news/feeds.ts`), parses each into articles, and
scores every article against every Kept Company Profile. Each pair is stored, so an article about
two Kept companies is stored once for each, which is what `news_items.profile_id` already meant.

- **One constant.** `NEWS_FEEDS` is the whole list, with each feed's `robots.txt` position and
  why it is a document meant for software written beside it. Adding a feed is one entry and a
  capture.
- **The initial set is Techmeme alone.** TechCrunch's `/feed/` is open to the `User-Agent` this
  project sends, but its `robots.txt` asks Anthropic's agents to fetch nothing, and every capture
  in this repo is taken by a Claude Run. It is left out until a capture is taken by hand.
- **Parsing is offline.** `parseNewsFeed` reads RSS 2.0 through a Zod schema keyed by RSS's own
  element names, against a committed capture of each feed. A feed that is not well-formed, is
  not RSS, or has no items is a rejection naming the feed. One bad item costs that item.
- **Fetching is one module.** `lib/news/feed-fetch.ts` is the only file under `lib/news` that
  fetches, and `lib/ingest/boundaries.test.ts` now reads `lib/news` to hold it to that; the GNews
  client fetched from outside that test's reach. It sends the same `User-Agent` as the
  accelerator and Y Combinator Sources, at one request a second per host.
- **Failure is every feed failing.** Until Jack Keeps a Company Profile there is nothing to match
  against, so a correct run can write zero rows, and that is not a failure. A run that read no
  feed at all has checked nothing, and exits non-zero. A feed fails when it cannot be fetched,
  does not parse, or has every item rejected, since that is a changed shape and not a quiet day.
  A feed that fails beside one that was read is named in the run's output, and the run succeeds.
- **No new credential.** `GNEWS_API_KEY` is gone from the code, `.env.example`, the ingest
  workflows and the bundle check. News needs nothing but the ingest role's connection.

Idempotence needs nothing new. `news_items` already has a unique index on `(profile_id, url)`, and
since a Company Profile has exactly one owner, that is at least as strict as one on
`(owner_id, profile_id, url)`. No migration is needed.

## Considered Options

**A keyed search API: GNews, or NewsAPI.org as ADR 0010 considered.** Rejected for this Ticket:
the key does not exist, and a search spends a quota per Kept company where a feed costs one
request.

**Google News RSS search.** Rejected, as ADR 0010 did, and now for a firmer reason than its lack
of a contract: its `robots.txt` disallows it.

**A publisher's own search, such as Techmeme's `/search/` or TechCrunch's `/?s=`.** Rejected:
every site checked disallows its search paths.

## Consequences

**Coverage is the honest cost.** A search API covered all news; this covers the feeds chosen. An
article about a Kept company in a publication whose feed is not read is invisible, where GNews
would have found it. And a feed carries only its latest items, so an article that rolls off the
feed between two daily runs is missed as well. The mitigation is that adding a feed is one line.

**Most stored rows score zero.** Every item in every feed is stored against every Kept Company
Profile, including the pairs that have nothing to do with each other. That is ADR 0010's design
applied to a source that does not pre-filter by name. The table grows by at most the feed's
items times the Kept companies per run, and a re-run adds nothing for items already stored.

**`source_name` is the feed's publication.** A Techmeme item links to Techmeme's permalink for
the story, so its `source_name` is "Techmeme", although the story it summarises may be the Wall
Street Journal's. The original publication stays in the headline, where Techmeme puts it.

**A url is now the feed's own.** ADR 0010 declined to normalise urls because one provider
returned each the same way every time. Each feed returns its own links the same way every time,
so that reasoning holds per feed. The same story linked by two feeds is two articles.

**A live capture is committed.** ADR 0010 had to test GNews against its documented shape because
a Run had no key. A feed needs none, so `db/fixtures/news-feed-techmeme.xml` is a real capture,
and the parser is tested against what the feed actually served.
