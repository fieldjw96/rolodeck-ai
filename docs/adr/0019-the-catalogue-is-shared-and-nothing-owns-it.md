---
status: accepted
---

# Company Profiles, News and Events are a shared catalogue that nothing owns

Every table in this repo carried an `owner_id` referencing `auth.users`, with an RLS policy
restricting reads to `(select auth.uid()) = owner_id`. That was correct while there was exactly
one account, and `db/schema.ts` said so plainly: owning every row from day one meant RLS had
something to match on and multi-user would be additive rather than a migration.

Half of that held. The additive half did not, and the way it failed is the reason for this ADR.
A second user signing in today sees a **completely empty application**: every row belongs to the
one id in `ROLODECK_OWNER_ID`, no policy matches, and an empty Deck is indistinguishable from a
working one. Nothing reports it. `lib/ingest/env.ts` already described this exact failure for a
mistyped owner — _"a Profile written with an `owner_id` nobody signs in as is not wrong-looking,
it is invisible"_ — without noticing that a second account produces it for every row at once.

So `owner_id` comes off `profiles`, `news_items`, `events` and `event_attendances`, and their
read policies become any authenticated user. A company, the people who founded it, the articles
written about it and the events it attends are facts about that company. They are the same facts
for every User, and nothing owns them. `owner_id` survives on `swipes` and `user_profiles`, where
it already means what its name says.

This is the line between **Catalogue** and the personal, and CONTEXT.md now names it.

## Considered Options

**Keep `owner_id` and change only the read policy to `true` for `authenticated`.** Much less
migration: no column drop, no index rebuild, no change to the idempotency key. Rejected because
the column would then mean "who ingested this" while its name, its foreign key and its cascade
all say "who owns this". Every future reader would believe those rows are private, and the first
one to write a feature on that belief would be right to be angry. A column that lies is a worse
inheritance than a migration.

**Give the catalogue to a system account** that every User can read through a policy naming it.
Rejected: it keeps the cascade, so deleting one `auth.users` row still deletes the entire
catalogue, and it invents an account that cannot sign in to avoid admitting that nothing owns
these rows.

**Copy the catalogue per User.** Rejected on sight. It multiplies ingest by the number of users,
stores the same company once per person, and makes the most interesting thing a second user
enables — that four people Kept the same company — impossible to express.

## Consequences

**`ROLODECK_OWNER_ID` ceases to exist.** It was the single-player linchpin: declared in
`lib/ingest/env.ts`, consumed by `db/ingest.ts`, `db/events.ts` and `db/seed.ts`, read by four
scripts, and set as a secret in seven workflow files. All of it goes.

**ADR 0008's idempotency key loses a column**, from `(owner_id, source, name_key)` to
`(source, name_key)`. The generated `name_key` and the guarantee it provides are unchanged, and
the key is now stronger rather than weaker: the same company from the same Source is one row
globally instead of one row per account.

**ADR 0013's two deferred risks disappear rather than being mitigated.** That ADR recorded that
`INSERT` accepts any `owner_id`, so ingest could write a row into any account, and that
`ingest.kept_profile_ids(for_owner)` answers for whichever owner it is asked about. The first is
gone because there is no `owner_id` on the tables ingest writes. The second is not: Keeps are
still owned, so that function still takes an owner and still needs the care ADR 0013 gave it.

**News gathering stays driven by Jack's Keeps, and every User reads the result.** This is the one
place the Catalogue split leaves a genuine choice, and it is decided conservatively. An article
is fetched because Jack Kept the company; once fetched it is Catalogue and everyone sees it. The
alternative, gathering for any User's Keeps, is better for a User who Keeps something Jack has
not, and it also means a single account can point the scrapers at several hundred companies by
swiping. With open sign-up per ADR 0020 that is an unbounded cost in someone else's hands. The
consequence to accept honestly is that a User who Keeps a company nobody else has will see no
News for it, and the Diary will not mark its Events important for want of an Attendance lookup.
Widening this later is a Ticket and a rate conversation, not a schema change.

**The anonymous role still sees nothing.** Reads widen to `authenticated`, never to `anon`, and
the existing test that asserts the anon role reads zero rows through the same handle as the
passing tests is the one that must keep passing. Six test files already define a second user id
for isolation; those tests now assert that the Catalogue is _shared_ and the swipes are _not_,
which is a change in what they mean and not merely in what they expect.
