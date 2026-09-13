---
status: accepted
---

# News stores every candidate article with a confidence, and filters on read

News is articles about a Kept Company Profile. Finding them means searching a news provider by
company name, and a company name is a poor search key: "Mercury" is a bank, a planet, an
element and an insurer, and a provider has no idea which one Jack Kept. So every article comes
back as a candidate, and something has to judge whether it is about the right company.

That judgement is `scoreNewsMatch` in `lib/news/match.ts`, which reads the company's name and
Sector against the article's headline and standfirst and returns a number from 0 to 0.95. Every
candidate is written to `news_items` with that number in `confidence`, including the ones it
scores at zero. What the owner sees is decided when reading, by `readNews` in `db/news.ts`,
against `NEWS_DISPLAY_THRESHOLD`, which is a named constant beside the rule and nowhere else.

The reason is the same one ADR 0002 gives for keeping real data rather than discarding it. The
first threshold will be wrong. If candidates were dropped at fetch time, finding that out would
mean re-fetching everything, against a provider with a daily quota; stored with their scores,
it means changing one constant and reloading the page. Jack has accepted that matching will be
noisy. What this avoids is noise nobody can measure: a boolean decided at fetch time and
forgotten says nothing about how close each call was.

The threshold starts at 0.6, the score of the weakest article the rule can be said to have
placed: the name in the headline plus one term from the company's own Sector. The name in the
headline plus only generic business words scores 0.55 and is hidden, because generic business
words are exactly what a larger company sharing the name also produces.

## The provider: GNews

GNews (`gnews.io`, `/api/v4/search`) is a keyed JSON search API over current news.

- **Cost at this volume: nothing.** News only searches for Kept companies, of which there are
  two, and one run makes one request per company. The free plan allows 100 requests a day and
  10 articles per request. It is described as not for commercial use, which a single-player
  tool that nobody else uses is not. If that changes, Essential is €39.99 a month for 1,000
  requests a day.
- **Rate limits.** One request a second on the free plan, ten on paid plans, answered with a
  429 past that; a spent daily quota is a 403 until 00:00 UTC. The throttle is set to the
  free-plan limit, through the existing `lib/ingest/throttle.ts`.
- **Shape.** Title, description, url, `publishedAt` and a source name on every plan. Full
  article text is paid-only, which is why the matcher is written against the headline and
  standfirst alone.

The key is sent in the `X-Api-Key` header, which GNews accepts as an alternative to its
`apikey` query parameter, so the request URL — the thing most likely to be logged — never holds
it.

## Considered Options

**Decide at fetch time and store only matches.** Smaller table, simpler read. Rejected for the
reason above: every retune becomes a re-fetch, and a wrong call leaves no trace.

**Store candidates in a separate table from displayed items.** Rejected: "displayed" is not a
property of a row, it is a comparison against a number that is expected to change, and moving
rows between tables on every retune is the re-fetch problem again with less network.

**NewsAPI.org.** The best-known option, but its free Developer plan is licensed for development
and testing only, delays articles by 24 hours, and the first plan allowed in production is
Business at $449 a month — out of proportion to two searches a day.

**Google News RSS.** Free and keyless, but it is not a documented API, carries no stable schema
to validate against, and would need its HTML-wrapped descriptions scraped. CLAUDE.md treats
scraped data as hostile; picking a source with no contract makes that worse for no gain.

**Idempotent on the url alone, across Company Profiles.** Rejected: one article about two Kept
companies is News about each, with a different confidence for each.

**A normalised, generated url key, as `name_key` is for Profiles.** ADR 0008 generates
`name_key` because the same company arrives spelled differently by different Sources. An
article's url arrives from one provider that returns it the same way each time, and a url's
path and query are case-sensitive and sometimes meaningful, so there is no normalisation that
is safe to apply. The part of ADR 0008 that does carry over is kept: the key is a unique index
in Postgres, not a read-then-insert, and a re-run is an update counted with `xmax = 0`.

## Consequences

A re-run re-scores. An update replaces `confidence` along with the headline, so a retuned
_rule_ takes effect on stored articles the next time they come back from the provider, while a
retuned _threshold_ takes effect immediately. `description` is stored, although nothing
displays it, so that a later rule can re-score stored rows without the provider at all.

`news_items` carries `owner_id` so its RLS policy is a plain equality, like `swipes`. There is
no insert or update policy: only the ingest script writes News, through the RLS-bypassing
connection. Check constraints keep `confidence` within 0 to 1 and `url` on http(s) for that
path, since the page renders `url` as a link.

News is shown only for companies Kept at the time of reading, not merely at the time of
fetching, so Passing a company that was once Kept removes its News from the page without
deleting it.

No live GNews response is committed as a fixture. A Run is not given a GNews key, and this
repo does not hand-write fixtures and call them captures; the parser's tests build GNews's
documented shape field by field instead. The first real run is the first real check that the
documented shape is the served one, and the Zod boundary is what makes that check loud.
