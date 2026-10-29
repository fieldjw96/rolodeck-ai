# Rolodeck AI

A fully AI-authored swipeable deck of Bay Area startup profiles, deployed at
https://rolodeck-ai.vercel.app. It began as a stress test of an unattended dispatcher and is
the product now; ADR 0012 records where that changed.

Runs on this repo are dispatched by `foreman`, whose vocabulary it inherits as-is: Ticket,
Run, Gate and Acceptance Criteria are defined in `foreman`'s own documentation and are not
redefined here. Bounce and Lane are not used: a pull request that needs more work gets
another Run, and there is one kind of agent.

## Language

**User**:
A person with an account, who works through the Deck and Keeps what interests them. Anyone may
become one; see `docs/adr/0020`. A User is never a Founder: Founders are the subject of the
product and the two never meet. There is no role above User and no administrator.
_Avoid_: owner, member, account, customer

**Company Profile**:
One startup's record in the Deck: name, description, sector, stage, and provenance. Part of the
Catalogue, so the same Company Profile is the same row for every User. Formerly just "Profile";
qualify it always now that **User Profile** below is a distinct thing.
_Avoid_: card, entry, listing, and the bare word Profile

**Founder**:
A person a Source states is behind a Company Profile, stored as that Source stated them: name,
and where stated, role, biography and links. Never an email address. Where the Source states
nobody, a Founder may instead be read from the company's own site, attributed `enriched`, and
only if the page states their name verbatim. See `docs/adr/0016`. Founders are the subject
of the product and never its users, and not entities of their own: someone who founded two
companies is two Founders.
_Avoid_: team member, contact, person

**Catalogue**:
Everything the pipeline gathers and every User sees identically: Company Profiles, Founders,
News, Events and Attendances. Nothing owns it. The line it draws is with the personal half, a
User's own swipes and User Profile, which nobody else can read. See `docs/adr/0019`.
_Avoid_: library, dataset, corpus, the pool

**User Profile**:
One User's stated preferences, which rank their Deck: sectors, stages, area, exclusions. Private
to that User. Ranks rather than filters, except exclusions; see `docs/adr/0011`.
_Avoid_: settings, preferences, brief

**Deck**:
The ordered set of Company Profiles a session works through, ranked by the User Profile. Every
Company Profile not yet swiped appears except those in an excluded Sector. See `docs/adr/0011`.
_Avoid_: feed, list, queue

**Keep** / **Pass**:
The two swipe actions on a Company Profile. Keep marks it worth a conversation; Pass
dismisses it from the current Deck without deleting the Company Profile.
_Avoid_: like/dislike, save/skip, accept/reject

**Sector**:
A Company Profile's industry, drawn from a closed list of twelve so a User Profile's stated
preference has something fixed to rank against: `ai-ml`, `developer-tools`,
`data-infrastructure`, `saas-enterprise`, `fintech`, `health-bio`, `security`,
`hardware-robotics`, `climate-energy`, `consumer-marketplace`, `vertical-saas`, `other`. Every
Source maps its own raw sector text onto one of these at ingest, rather than writing free
text; `other` is the honest answer when nothing else fits, not a bug.
_Avoid_: industry, category, tag

**Stage**:
A Company Profile's funding stage: `pre-seed`, `seed`, `series-a`, `series-b-plus`, `growth`, or
`not-stated` where the Source gave no stage and none could be derived. `not-stated` is the honest
answer for a company whose round nobody stated, as `other` is for Sector, and is never a
preference a User Profile can state. See `docs/adr/0015`.
_Avoid_: round, series

**Provenance**:
Where a Company Profile field's value came from: `scraped`, `enriched`, or `jack`. Carried
per field, not per Company Profile, matching rolodeck's own rule so the two repos stay
comparable.
_Avoid_: source, origin

**Source**:
One place Company Profiles are ingested from — SEC filings, Show HN, an accelerator's own
pages — named as a lowercase slug. A Source is where a record came from; its Provenance is
what kind of value each of its fields is.
_Avoid_: feed, provider, site

**News**:
Articles about a Company Profile. Part of the Catalogue: gathered for every Company Profile the
Catalogue holds, whoever has Kept it, and read by the Users who Keep that company. See
`docs/adr/0022`, which amends `docs/adr/0019` on who gathering is for.
_Avoid_: dispatch, feed, updates

**Attribution**:
One article tied to one Company Profile, with the Confidence that it is about that company. An
article is stored once whoever it is about; an Attribution is what says it is about somebody,
and exists only where the matcher scored the pair above zero. See `docs/adr/0022`.
_Avoid_: news item, match, link

**Feed**:
A syndication document a publisher offers for software to read, such as Techmeme's RSS, which
News reads articles from. Never a synonym for News or for a Source. See `docs/adr/0015`.
_Avoid_: provider, river, stream

**History search**:
News's other path: a search of the last two years of Hacker News for one Company Profile, run
once ever, the first News run that sees it, and capped per run — plus one re-run of its own-site
half for a Profile covered before the news rule existed. Every article it finds is kept, and
scored against that Profile alone. See `docs/adr/0018`, `docs/adr/0022` and `docs/adr/0024`.
_Avoid_: backfill, lookup

**Own-site post**:
A post the history search found on a Company Profile's own domain, so written by the company
about itself. Shown only when it is news — an announcement that something happened — and stored
but hidden when it is an essay, an opinion piece or a tutorial. See `docs/adr/0024`.
_Avoid_: blog post, content, thought leadership

**Confidence**:
How sure News is that an article is about the Company Profile it is attributed to, from 0 to 1.
Every pair is scored and every score is counted in the run log; a pair above zero is stored, and
only those at or above the display threshold are shown. See `docs/adr/0010` and `docs/adr/0022`.
_Avoid_: relevance, score, match quality

**Diary**:
The calendar of Events.
_Avoid_: calendar, agenda

**Event**:
A startup event with a name, date, location and link. Exists independently of any company;
companies may attend it.
_Avoid_: meetup, conference

**Attendance**:
A Source's own statement that a Company Profile takes part in an Event — hosting it, presenting
at it. Never inferred. An Event attended by a Company Profile the viewing User has Kept is marked
important in their Diary, so the same Event can be important to one User and not another; an Event
with no known Attendance is still shown.
_Avoid_: participant, guest, RSVP
