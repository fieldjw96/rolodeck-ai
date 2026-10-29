---
status: accepted
amends: 0018, 0022
---

# Every search result is kept, and a company's own post is shown only when it is news

This amends docs/adr/0018 and docs/adr/0022. It does not supersede either.

Two things were true on `main` and are not any more.

**A history search's results were thrown away.** `run.ts` scored every search hit with
`scoreNewsMatch` and stored only the pairs above zero. `scoreNewsMatch` returns 0 unless the
company's name is in the headline or the standfirst, and a company's own post almost never names
the company. A 0 was not a `news_items` row, and search results were not in `news_articles`
either — the table said "feed articles only" — so nothing at all was written. Then
`recordNewsCoverage` marked the Profile searched for good. The articles News was _most certain_
about were the ones it lost, permanently, and that is a large part of why the News page is nearly
empty.

**And the decision not to show them was never really made.** ADR 0018's consequence said "A
company's own writing mostly scores low … This ADR does not retune it", which read as a deferral
and worked as a deletion.

## The decision

**Every article `parseHistorySearch` returns is stored**, in the run that found it, whatever it
scores, in `news_articles` beside the feed and Launch HN articles.

That table's rows were Catalogue: an article stored once and scored against every Company
Profile, now and in the future. A search result is not Catalogue in that sense — ADR 0018 is
explicit that it is scored against the Company Profile it was searched for and no other, because
a targeted result is about the company it was searched for or it is about nothing. So the table
gains a nullable `searched_for_profile_id`:

- **Null** means what every row meant before: a feed or Launch HN article, scored against the
  whole Catalogue.
- **Set** means a search found it for that one Company Profile, and nothing scores it against
  any other — not in the run that found it, and not on any later run, where the stored-article
  path reads the column and skips the pair rather than forming it.

The column is written when the row is first inserted and never updated, and ingest holds no
`UPDATE` grant on it. So an article a feed carried first stays Catalogue when a search later
finds the same url: the wider treatment wins, because it was already true.

**An own-site post reaches the News page only when it is news.** A hit from the `site` query has
had its host checked against the Company Profile's own domain, so who wrote it is not in doubt.
Its confidence is therefore decided by `isCompanyNews` in `lib/news/company-news.ts` rather than
by the matcher alone:

- News — an announcement that something happened at the company: a raise, a launch, an
  acquisition, a hire, a release, a certification. Confidence is
  `max(scoreNewsMatch(...), NEWS_DISPLAY_THRESHOLD)`, so it is shown. A post that also names the
  company scores above the threshold and keeps that score; one that does not is lifted to exactly
  the threshold and no further, because knowing who wrote something is not knowing how much it
  matters.
- Not news — an essay, an opinion piece, a tutorial, a thought-leadership post. Confidence is
  capped just below `NEWS_DISPLAY_THRESHOLD`, written in terms of that constant: stored with what
  the matcher made of it, so a retune can reach it, and never shown. A post the matcher scored 0
  stays 0 and so is counted rather than stored as a pair, per ADR 0022 — the article itself is
  kept either way, which is the half of this ADR that matters most.

Jack's condition, verbatim: "the blog has to be actual news, not just an opinion piece about
something in the company for example". The rule is a declared list of terms anyone can read, in
the style of `COMPANY_CONTEXT_TERMS`, with opinion and tutorial signals overriding announcement
ones and "not news" as the default. No classifier and no model: what matters is that a stored
score can be explained by reading one file, which is ADR 0010's reasoning applied to this rule.

**Nothing else changes about scoring.** `scoreNewsMatch`, `MATCH_WEIGHTS` and
`NEWS_DISPLAY_THRESHOLD` are untouched, and a hit from the `title` query, a feed article and a
Launch HN post are scored exactly as they were. This changes how a company's own writing is
judged, not how the matcher works.

**What was already dropped is recovered, once.** ADR 0022 said a Company Profile is "searched for
once ever", and under the old rule that meant every own-site article found before today is gone
with no record of what it was. So a Company Profile already in `news_profile_coverage` that has
a searchable website gets its `site` query run once more, under the new rule, and
`news_profile_site_recovery` records that it has, so it is never re-searched again. A failed
re-search is recorded as nothing and retried on a later run.

The re-searches spend only the cap the first searches did not: `HISTORY_SEARCHES_PER_RUN` minus
this run's first searches. A Catalogue with new Profiles in it never spends its searches
repairing old ones, and the recovery arrives over however many runs have room — the same bound,
and the same reasoning, ADR 0022 gave for the first searches. The run report counts the
re-searches done, the ones that failed, and the ones still waiting.

## Considered Options

**Lift every own-site hit to the threshold.** The simplest reading of "the search is certain who
wrote this". Rejected on Jack's condition: a company blog is mostly essays, and a News page of
them is a worse page than an empty one.

**Retune `scoreNewsMatch` instead.** Give it a "this is the company's own domain" input and let
the weights do the work. Rejected for ADR 0018's reason for not retuning it here: the matcher
answers "is this article about this company", and an own-site hit has already answered that. The
question left is "is this news", which is a different question and deserves its own rule and its
own name.

**An LLM classifier for news-or-not.** Rejected. It would be the first model call in ingest, with
a key, a bill, and a non-reproducible answer, to replace a list of words that can be read, tested
offline and argued with.

**Re-search every covered Profile on every run until it finds something.** Rejected: that is the
daily-forever cost ADR 0022 built `news_profile_coverage` to avoid. Once, recorded, is enough,
because from here on every search result is kept as it is found.

**Store search results in a table of their own.** Rejected. An article is an article; the thing
that differs is who it may be attributed to, which is one nullable column, not a second table
with its own key, policies and grants. ADR 0022 rejected a nullable `profile_id` on `news_items`
because `profile_id` is what that table is keyed and read by; this column is keyed and read by
nothing, and exists to narrow a scoring loop.

## Consequences

**ADR 0018's consequence "A company's own writing mostly scores low … This ADR does not retune
it" is now answered.** It is not retuned; it is routed around, for own-site hits only, by a rule
with its own name.

**ADR 0022's "searched for once ever" becomes "first-searched once ever, and site-re-searched
once ever".** Two records, two tables, both insert-only. A third pass would need its own ADR and
its own cost argument.

**`news_articles` is no longer one kind of thing.** A row is Catalogue or it belongs to one
Company Profile, and every reader of that table has to know which. Today there are two:
`readStoredNewsArticles` → `scoreEvery`, which honours the column, and
`readLatestLaunchHnPublishedAt`, which reads only a published date off a `Launch HN:` title and
does not care. A third reader that ignores the column would quietly undo ADR 0018, which is why
the column is documented on the table, in the type, and in the loop that reads it.

**The news rule will be wrong about something.** It is a word list, and a company will announce
something in a headline nobody listed, or title an essay like an announcement. The cost is
bounded in one direction and not the other: a missed announcement is stored, scored and one
retune away from the page, while a false one is a visible mistake on it. That is why "not news"
is the default and why the opinion signals override the announcement ones.

**A deleted Company Profile takes its search results with it.** `searched_for_profile_id`
cascades, like every other reference to `profiles`. An article only in `news_articles` because
one Profile's search found it has no standing in the Catalogue once that Profile is gone.
