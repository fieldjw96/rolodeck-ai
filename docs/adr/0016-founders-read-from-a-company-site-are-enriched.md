---
status: accepted
---

# Founders read from a company's own site by a model are attributed `enriched`, and only fill a gap

Y Combinator is the only Source that states a team. Every Company Profile from
`south-park-commons`, `angelpad` and `show-hn` has `founders` null, about 325 of them, and
their Sources do not publish the information at all. The companies often do, on their own
sites. Ticket #175 fills that gap by reading the company's own site, and this records the three
decisions that doing so forced.

## 1. It is not a Source, so it updates rows and never creates one

docs/adr/0008 makes `source` part of a Company Profile's identity. Writing what a company's own
site says as a new Source would deal the Deck a second card for a company it already holds,
which is the opposite of the point. So the enrichment only ever updates an existing row, through
`db/team-pages.ts`, as the ingest role, which may already update `profiles` (docs/adr/0013). It
needs one more column grant and nothing else: `founders_sought_at`, from migration 0011.

It only fills a gap. Every write is conditional on `founders` still being null, in the statement
itself, so a Profile whose Source states a team is never touched whatever the page says. The
reverse holds too: a Source re-ingest that states a team replaces enriched founders, because a
Source outranks a gap-fill. A Source re-ingest that still states nobody keeps them. Without
that, `persistProfiles` would null them out on every weekly accelerator run, since its
`on conflict` replaces `founders` wholesale. `db/ingest.ts` carries that one exception.

## 2. The founders it writes are `enriched`, never `scraped`

`scraped` means the Source stated the value in a form we read directly: a field in a filing, a
JSON property on a page. A team page has no shape in common between two companies, so it is read
by a model reading prose, and that reading cannot claim the same fidelity. docs/adr/0009
already refused to put a guess under a `scraped` tag. This is the same rule applied to a new
kind of reading: the name is on the page, but that the page states this person _founded_ the
company is the model's judgement, not something read directly.

`founders_sought_at` is not provenanced. Like `created_at` it records what ingest did, not a
fact about the company. It exists because `founders` being null already means "the Source
stated none", so it cannot also say whether anyone has looked. Null there means never looked;
a timestamp means looked, and if `founders` is still null, the page named nobody or could not
be read.

## 3. The model's answer is hostile input, and a name the page does not state is dropped

Every other parser here is deterministic and pinned by a committed capture. A model's reading
cannot be pinned that way, so it is contained the way scraped data is (CLAUDE.md). The answer
must be strict JSON, and it crosses `teamAnswerSchema`, a strict object holding name, role and
bio and nothing else, so an email, an image or a URL is refused rather than dropped. A response
that fails either test is a rejection naming what failed, and costs that one company.

Then comes the one check a fixture _can_ pin. A person whose full name does not appear, whole
and verbatim, in the page text the model was given is not a person that page stated, and is
dropped and counted. `lib/ingest/team-answer.test.ts` drives it from a committed page capture
and a synthetic answer holding one real name and one invented one. That test is what stands
between this and a card full of plausible invented people. Whitespace is the only difference
the check forgives, and "whole" means a name that is merely a prefix of a longer one does not
count.

The check does not prove the model read the role right, or that a named person is a founder
rather than an employee. That residue is exactly what `enriched` says.

## How it runs, and what it may touch

- **`robots.txt` is fetched per origin, before anything else on it, and obeyed** (RFC 9309).
  There is no allowlist: the sites are whatever the Profiles hold. One that refuses is skipped,
  counted and recorded as attempted. One that cannot be read at all means nothing on that host
  is requested. LinkedIn, whose `robots.txt` refuses every client, is out of reach by
  construction as well as by the Ticket.
- **Only the company's own site is fetched.** Links and redirects that leave it, to a social
  network, a directory or a subdomain, are not followed. At most the homepage and two linked
  pages are read per company.
- **One request a second per host**, with the same honest `User-Agent` the accelerator Source
  sends. `lib/ingest/team-page-fetch.ts` is the only module that does this, declared in
  `lib/ingest/boundaries.test.ts`.
- **The model is invoked through `anthropics/claude-code-action@v1` with
  `CLAUDE_CODE_OAUTH_TOKEN`**, the credential `claude-review.yml` already uses. No new secret
  reaches Actions. The model step holds no database credential, may not run a shell or fetch
  anything, and is told to read and write only in the run's working directory. That makes the
  run three steps in `.github/workflows/ingest-team-pages.yml`: gather, read, apply. The apply
  step checks each answer against the text the gather step recorded, not against anything the
  model step could have rewritten.
- **The run is bounded** by `TEAM_PAGE_CANDIDATES_PER_RUN`, with never-read Profiles first, then
  oldest attempt. A site read in the last `TEAM_PAGE_RETRY_AFTER_DAYS` is not taken again.

## Considered Options

**LinkedIn.** Its `robots.txt` is a single `Disallow: /` for every client. Every Source in this
repo is allowed by the site it reads, and Google News RSS was dropped on exactly this test.

**Attribute them `scraped`, since the name is verbatim on the page.** Rejected for the reason in
2: the name is verbatim, but who is a founder is a reading.

**A model API key in Actions secrets.** Simpler to call from the ingest process, but CLAUDE.md
and docs/adr/0013 constrain what Actions may hold, and the existing OAuth credential can do
this job as a workflow step.

## Consequences

- `founders` now has two provenances in practice, and a reader that ignores `provenance.founders`
  cannot tell a team YC stated from one a model read off a homepage.
- Expect a low hit rate. Many early companies have a one-page site that names nobody, and the
  run reports that plainly: a run that read its whole quota and updated nothing is a success.
  A run where every candidate failed to fetch is not.
