# Rolodeck AI

A fully AI-authored swipeable deck of Bay Area startup profiles, deployed at
https://rolodeck-ai.vercel.app. It began as a stress test of an unattended dispatcher and is
the product now; ADR 0012 records where that changed.

Runs on this repo are dispatched by `foreman`, whose vocabulary it inherits as-is: Ticket,
Run, Gate and Acceptance Criteria are defined in `foreman`'s own documentation and are not
redefined here. Bounce and Lane are not used: a pull request that needs more work gets
another Run, and there is one kind of agent.

## Language

**Company Profile**:
One startup's record in the Deck: name, description, sector, stage, and provenance. Formerly
just "Profile"; qualify it always now that **User Profile** below is a distinct thing.
_Avoid_: card, entry, listing, and the bare word Profile

**User Profile**:
The owner's stated preferences, which rank the Deck: sectors, stages, area, exclusions.
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
Articles about a Kept Company Profile.
_Avoid_: dispatch, feed, updates

**Confidence**:
How sure News is that an article is about the Kept Company Profile it is attributed to, from 0
to 1. Stored for every candidate article; only those at or above the display threshold are
shown. See `docs/adr/0010`.
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
at it. Never inferred. An Event one of the owner's Kept Company Profiles attends is marked
important in the Diary; an Event with no known Attendance is still shown.
_Avoid_: participant, guest, RSVP
