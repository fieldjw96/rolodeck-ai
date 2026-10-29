---
status: accepted
amended-by: 0024
---

# News gathers for the whole Catalogue, and stores an article once

This is the second ADR numbered 0022; the other is the audit gate, as 0015 is both the
not-stated stage and reading publisher feeds. A reference to "ADR 0022" in the News code and
docs means this one, and the file name is the unambiguous way to say which.

News stops asking whose Keeps to gather for. Every Company Profile in the Catalogue is scored
against every feed article, and every Company Profile is searched for once, over two years of
Hacker News, the first time a News run sees it. A feed article is stored once in its own table
whoever it turns out to be about, and attributed to a Company Profile in `news_items` only when
the matcher scores that pair above zero.

What a User reads does not change. `readNews` still answers with News for the companies that
User Keeps and nothing else.

This amends three decisions:

- **ADR 0019**, which narrowed gathering to one User's Keeps. There is no gathering User any
  more, and `ROLODECK_NEWS_KEEPS_USER_ID` is gone.
- **ADR 0010**, which stored every article-and-Profile pair including the ones scoring zero. The
  pairs are still all scored, and still all counted in the run log, but only the ones above zero
  become rows.
- **ADR 0018**, which searched a year of Hacker News per Kept company. The window is two years
  and the subject is every Company Profile, once each.

It also narrows **ADR 0013**: the ingest role no longer holds `EXECUTE` on
`ingest.kept_profile_ids`, because nothing calls it. Migration `0016_news_for_the_catalogue`
drops the function and the `ingest` schema with it, which also closes that ADR's second deferred
risk — a function that answered about whichever owner it was asked about.

## Why the Catalogue does not reopen ADR 0019's cost argument

ADR 0019 rejected gathering for every User's Keeps, and it was right to. With sign-up open per
ADR 0020, a stranger can swipe Keep a few hundred times in an afternoon, and under that rule
each Keep points the scrapers at another company. The size of the job would be set by whoever
cared to set it, and the bill — requests to publishers, requests to Algolia, rows in Postgres —
would be Jack's.

Gathering for the Catalogue has neither half of that problem.

**The size is decided by ingest, not by Users.** The Catalogue grows when a Source run writes a
Company Profile. No swipe adds one, and a User who Keeps everything on the Deck adds no work at
all, because the work was already done when the company arrived. The cost is a function of how
many companies Jack's own pipeline has ingested, which is the quantity he was already choosing.

**The work per company is paid once.** The feeds are read once a run however large the Catalogue
is: an article is fetched once and scored against the Profiles in memory. The only per-company
request is the history search, and `news_profile_coverage` records that it happened, so a
Company Profile is searched for on the first run that sees it and never again. _Amended by
docs/adr/0024:_ once more, for its `site` query alone, because everything that query found
before was thrown away — recorded in `news_profile_site_recovery`, spending only the cap the
first searches leave, and then never again. A Catalogue of a
thousand companies is a thousand searches spread over however many runs it takes, not a
thousand searches a day.

**And it is capped.** `HISTORY_SEARCHES_PER_RUN` bounds how many Profiles one run searches for;
the rest wait for the next run, oldest-created first, and the run summary says how many are
waiting. So the worst a large ingest can do is make coverage arrive over several days.

What remains is that the matcher now runs against the whole Catalogue rather than a handful of
Kept companies, which is arithmetic in memory and costs nothing to anybody outside this process.
It does raise the chance that a loose match is stored for a company nobody is watching, which is
why the run summary now counts the feed articles that cleared `NEWS_DISPLAY_THRESHOLD` against
more than one Company Profile. A matcher misfiring at Catalogue scale shows up in the run log,
rather than only on somebody's page.

## Storage: the article and the attribution come apart

ADR 0010 stored every candidate pair, zeros included, so that a retuned threshold could be
applied to what was already fetched without fetching it again. That reasoning is still right, and
at eight Kept companies it was cheap: fifteen articles against eight companies was 120 rows on
2026-10-24, one above the threshold.

Against the whole Catalogue the same rule is tens of thousands of rows a day, nearly all of them
zero, and almost all of that is the same handful of articles written out once per company. So:

- **`news_articles`** holds each feed article once, unique on `url`, whether or not it matches
  anything: title, description, url, published date, source name, and when it was first stored.
- **`news_items`** holds the attributions, as it always has, keyed on `(profile_id, url)` — but
  only for a pair the matcher scored above zero.

Keeping every article, matched or not, is what the zero rows were really for. A Company Profile
that enters the Catalogue next month is scored, on its first run, against every article already
read, so it arrives with its News rather than waiting for the next thing published about it. A
retune still has everything it needs: the articles are all there, and the pairs that mattered —
anything the rule placed at all — are all there too. What is lost is the ability to re-read, for
a pair that scored exactly zero, that it scored exactly zero. The run log keeps the distribution,
so the shape of what scored nothing is still visible; the individual zero is not worth a row.

The zero-confidence rows already in `news_items` are left alone. The display threshold hides
them, and deleting them is work with nothing to show for it.

## Coverage is recorded, not inferred

Which Company Profiles have been scored against the stored articles and searched for over Hacker
News is a row in `news_profile_coverage`, keyed on `profile_id`. It is not inferred from whether
a Profile has `news_items` rows, because finding nothing is the ordinary outcome for a two-person
company and would mean searching for it again every day forever.

A Profile is recorded only when both halves actually happened, and only after the write
succeeded. A search that failed — the API answered 503, or its shape changed — leaves no row, so
the Profile is tried again on the next run. The cap works the same way: a Profile the run never
reached is simply not recorded.

## Considered Options

**Gather for every User's Keeps.** The option ADR 0019 rejected, for the reason restated above:
it puts the size of the job in a stranger's hands. Rejected again, and now moot — gathering for
the Catalogue covers every company any User could Keep, which is the outcome that option was
for.

**Keep the zero rows and gather for the Catalogue anyway.** Rejected on volume. Nearly every row
written would be a zero, and the thing they bought — being able to score a new Company Profile
against articles already read — is bought better by keeping the articles once.

**A nullable `profile_id` on `news_items` instead of a second table.** One table, with unmatched
articles as rows attributed to nobody. Rejected: `profile_id` is what `news_items` is keyed and
read by, and a nullable key makes every query and every policy carry a case that means something
else entirely. Two tables say plainly that an article and an attribution are different things.

**Re-search the history periodically.** Rejected as a separate question. After the first run, new
coverage comes from the feeds; a refresh is its own Ticket with its own cost argument.
