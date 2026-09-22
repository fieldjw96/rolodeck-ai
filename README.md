# rolodeck-ai

A swipeable deck of early-stage Bay Area startup profiles. Each card is a company, built from
public sources: Y Combinator, SEC Form D filings, accelerator batches and Show HN. Swipe to
Keep or Pass. Kept companies go on a Watchlist, with related news and events tracked
alongside.

Live at https://rolodeck-ai.vercel.app (sign-in required).

The codebase is written by AI agents, working from GitHub issues through
[foreman](https://github.com/fieldjw96/foreman), and every change arrives as a pull request.

## Features

- **Deck**: company profiles, ranked and dealt one at a time. Every field records its source
  and the date it was captured.
- **Watchlist**: the companies you've Kept.
- **News**: articles from publisher RSS feeds and a year of Hacker News, matched to Kept
  companies and scored for confidence.
- **Diary**: upcoming Bay Area events from Luma calendars and Techmeme, linked to the
  companies hosting them.

## Stack

TypeScript (strict), Next.js App Router on Vercel, Supabase (Postgres and Auth), Drizzle,
Zod at every external boundary, Vitest and Playwright.

## Getting started

Requires Node 22.x and a Supabase project.

```
cp .env.example .env.local   # fill in the Supabase values
npm install
npm run dev
```

There is no sign-up. Create the single account with:

```
npm run account:provision -- you@example.com
```

## Testing

```
npm run typecheck && npm run lint && npm run format:check
npm run test        # Vitest, against an in-process Postgres and stub Auth
npm run test:e2e    # Playwright, same stubs, builds its own server
```

Neither test command needs a database or a Supabase project. CI runs all of the above, plus
`npm audit` and a check that no server secret has leaked into the client bundle.

## Documentation

- [`docs/development.md`](docs/development.md): environment, the full test suite, and the database
- [`docs/deploying.md`](docs/deploying.md): the deploy workflow, its secrets, and manual deploys
- [`docs/ingest.md`](docs/ingest.md): data sources, scheduled runs, and the ingest database role
- [`docs/api.md`](docs/api.md): the Profiles and News API, and security headers
- [`docs/adr/`](docs/adr/): architecture decision records
- [`CONTEXT.md`](CONTEXT.md): domain vocabulary
- [`CLAUDE.md`](CLAUDE.md): rules for agents working in this repo
