import { sql, type SQL } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";

import {
  SECTOR_VALUES,
  type CompanyLinks,
  type Founder,
  type Sector,
  type Stage,
} from "./profile-input";
import {
  NULLABLE_FIELDS,
  PROVENANCE_VALUES,
  PROVENANCED_FIELDS,
  type ProfileProvenance,
  type ProvenancedField,
} from "./provenance";

const provenanceLiterals = PROVENANCE_VALUES.map((value) => `'${value}'`).join(
  ", ",
);

const sectorLiterals = SECTOR_VALUES.map((value) => `'${value}'`).join(", ");

/**
 * A company name reduced to what identity actually depends on: case-folded, with runs of
 * whitespace collapsed and the ends trimmed. See docs/adr/0008.
 *
 * One expression, used twice: as the definition of `profiles.name_key`, and by events ingest
 * to match an attendee a Source names against the Company Profiles already in the Deck. Kept
 * as the single source of that rule so there is never a second way of comparing names.
 */
export const nameKeyOf = (value: SQL): SQL =>
  // POSIX `[[:space:]]` rather than `\s`, which a TypeScript template literal would eat
  // before Postgres ever saw it. Every function here is IMMUTABLE, as a generated column
  // requires.
  sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`;

/**
 * The Postgres role every ingest path connects as. See docs/adr/0013.
 *
 * `.existing()` because Drizzle cannot say what matters about it — that it is not a superuser,
 * cannot create roles, is a member of nothing, and holds grants on four tables only — so
 * migrations `0008_ingest_role` and `0009_ingest_update_columns` create and grant it by hand, and
 * `db/testing/ingest-role-check.sql` fails the tests if the role is any broader. Declared here so
 * the policies below are part of the schema Drizzle diffs rather than SQL it has never heard of.
 */
export const ingestRole = pgRole("rolodeck_ingest").existing();

/**
 * Ingest writes Catalogue rows, which nobody owns and ingest does not sign in to read, so no
 * policy written for a signed-in User could match it; these admit it to one table outright
 * instead, and it bypasses RLS on those four. A policy is scoped to its table, so they
 * reach nothing else: `swipes`, `user_profiles` and `auth` carry no policy for this role and
 * no grant to it, and a missing grant fails before RLS is ever consulted. Not `for: "all"`,
 * which would read as a delete right on tables ingest has no business deleting from.
 */
const ingestPolicies = (table: string) => [
  pgPolicy(`${table}_ingest_select`, {
    for: "select",
    to: ingestRole,
    using: sql`true`,
  }),
  pgPolicy(`${table}_ingest_insert`, {
    for: "insert",
    to: ingestRole,
    withCheck: sql`true`,
  }),
  pgPolicy(`${table}_ingest_update`, {
    for: "update",
    to: ingestRole,
    using: sql`true`,
    withCheck: sql`true`,
  }),
];

const hasValidProvenance = (field: string) =>
  `provenance ->> '${field}' in (${provenanceLiterals})`;

const isNullable = (field: ProvenancedField): boolean =>
  (NULLABLE_FIELDS as readonly ProvenancedField[]).includes(field);

/**
 * The database's own half of the per-field provenance rule. Zod guards the boundary in
 * TypeScript; this guards it for anything that reaches Postgres another way, including the
 * ingest role, which bypasses RLS on this table but not a check constraint.
 */
const provenanceCoversEveryField = sql.raw(
  // A CHECK passes when it evaluates to NULL, and `null in (...)` is NULL, so a field with
  // no provenance key at all would slip through unwrapped. The coalesce is what turns a
  // missing field into a rejection rather than a silently unattributed value.
  `coalesce(\n  ${[
    ...PROVENANCED_FIELDS.filter((field) => !isNullable(field)).map(
      hasValidProvenance,
    ),
    // The nullable Profile fields each carry provenance exactly when they have a value to
    // attribute. See `NULLABLE_FIELDS` in `db/provenance.ts`.
    ...NULLABLE_FIELDS.flatMap((field) => [
      `(${field} is null) = (provenance ->> '${field}' is null)`,
      `(${field} is null or ${hasValidProvenance(field)})`,
    ]),
  ].join("\n  and ")}\n, false)`,
);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Which ingest path wrote this row: `yc`, `sec-form-d`, and so on. Not a Profile field and
     * so not provenanced — `provenance` says what kind of value each field is, per CONTEXT.md,
     * while this says which pipeline produced the record. It is half the natural key below.
     */
    source: text("source").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    sector: text("sector").notNull(),
    stage: text("stage").notNull(),
    website: text("website"),
    /**
     * A human-readable place, such as "San Francisco, CA" — nullable because not every
     * Source states one. See CLAUDE.md: the product's central "Bay Area" claim is otherwise
     * unenforceable and unverifiable.
     */
    location: text("location"),
    /**
     * The people a Source states are behind the company, as that Source stated them. One
     * jsonb value rather than a child table because it arrives from one Source as a whole and
     * is replaced as a whole on re-ingest, the same shape `provenance` has. Null when the
     * Source stated nobody, never an empty list: see `founderListSchema`.
     */
    founders: jsonb("founders").$type<Founder[]>(),
    /** The company's own links beyond `website`. Null when the Source stated none. */
    links: jsonb("links").$type<CompanyLinks>(),
    /**
     * When the team-page enrichment last read this company's own site looking for founders, or
     * null if it never has. Not a Profile field and so not provenanced, like `created_at`: it
     * says what ingest did, not what the company is. It is what tells "never looked" apart from
     * "looked, and the page named nobody", which `founders` being null cannot say on its own
     * because null there already means the Source stated none. See docs/adr/0016.
     */
    foundersSoughtAt: timestamp("founders_sought_at", { withTimezone: true }),
    provenance: jsonb("provenance").$type<ProfileProvenance>().notNull(),
    /**
     * The name reduced to what identity actually depends on: case-folded, with runs of
     * whitespace collapsed and the ends trimmed. Generated by Postgres rather than computed in
     * TypeScript so that the key a row is deduplicated on cannot disagree with the name it
     * carries, whichever path wrote it. See docs/adr/0008.
     */
    nameKey: text("name_key").generatedAlwaysAs(nameKeyOf(sql.raw("name"))),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("profiles_provenance_covers_every_field", provenanceCoversEveryField),
    /**
     * The database's own half of the Sector vocabulary being closed. Zod guards the boundary
     * in TypeScript; this guards it for the ingest role, which bypasses RLS on this table but
     * not a check constraint, so `sector` cannot drift back to free text through it.
     */
    check(
      "profiles_sector_is_controlled",
      sql.raw(`sector in (${sectorLiterals})`),
    ),
    /**
     * The natural key ingest is idempotent on: one Company Profile per company name, per
     * Source, globally. It is a constraint rather than a convention because the write path
     * runs as the ingest role, which bypasses RLS on this table, and a duplicate it created
     * would be a second card for the same company in the Deck, not an error anything would
     * raise. Formerly `(owner_id, source, name_key)`; see docs/adr/0008 and docs/adr/0019.
     */
    uniqueIndex("profiles_source_name_key_idx").on(table.source, table.nameKey),
    /**
     * Orders `readDeckPage`'s rows newest first. It no longer carries the whole `order by`:
     * the Deck ranks by a score computed from the User Profile, which no index can hold, and
     * sorting the Catalogue is cheap at this volume. See docs/adr/0011.
     */
    index("profiles_created_at_id_idx").on(
      table.createdAt.desc(),
      table.id.desc(),
    ),
    /**
     * A Company Profile is Catalogue, so any signed-in User reads it and nobody owns it — see
     * docs/adr/0019. Defining any policy makes Drizzle enable RLS on the table, so the
     * anonymous role — which Supabase grants table privileges to by default — matches no
     * policy and still sees no rows. `authenticated`, never `anon`.
     */
    pgPolicy("profiles_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    ...ingestPolicies("profiles"),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

/**
 * The two swipe actions, spelled as CONTEXT.md spells them. Keep marks a Profile worth a
 * conversation; Pass dismisses it from the current Deck without deleting the Profile, which
 * is why a decision is a row of its own rather than a column on `profiles`.
 */
export const SWIPE_DECISIONS = ["keep", "pass"] as const;

export type SwipeDecision = (typeof SWIPE_DECISIONS)[number];

const decisionLiterals = SWIPE_DECISIONS.map((value) => `'${value}'`).join(
  ", ",
);

export const swipes = pgTable(
  "swipes",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    decision: text("decision").$type<SwipeDecision>().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One decision per user per Profile: swiping again is a correction, not a second row, so
     * the Deck cannot end up excluding a Profile for two contradictory reasons.
     */
    primaryKey({ columns: [table.userId, table.profileId] }),
    // Text plus a check rather than an enum, matching how `provenance` is constrained: the
    // set is closed in Postgres as well as in TypeScript, including for the ingest path.
    check(
      "swipes_decision_is_a_swipe",
      sql.raw(`decision in (${decisionLiterals})`),
    ),
    pgPolicy("swipes_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
    }),
    /**
     * A decision can only ever be recorded, or corrected, against the signed-in user, and
     * only about a Profile that user can see. A foreign key does not consult RLS, so without
     * the `exists` — which reads `profiles` through its own policy — an id belonging to
     * somebody else would be accepted here. There is deliberately no delete policy: nothing
     * in the app un-swipes a Profile.
     */
    pgPolicy("swipes_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.userId} and exists (select 1 from ${profiles} where ${profiles.id} = ${table.profileId})`,
    }),
    pgPolicy("swipes_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
      withCheck: sql`${authUid} = ${table.userId} and exists (select 1 from ${profiles} where ${profiles.id} = ${table.profileId})`,
    }),
  ],
);

export type Swipe = typeof swipes.$inferSelect;
export type NewSwipe = typeof swipes.$inferInsert;

/**
 * The owner's stated preferences, which the ranking Ticket reads. See CONTEXT.md: a User
 * Profile is distinct from a Company Profile, and this table is keyed by user id rather than
 * having an id of its own because the owner has exactly one row — see `readUserProfile` in
 * `db/user-profile.ts` for what a never-saved owner reads instead of a missing row.
 */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    sectors: text("sectors").array().$type<Sector[]>().notNull().default([]),
    stages: text("stages").array().$type<Stage[]>().notNull().default([]),
    // A plain string rather than an enum: there is exactly one value today, and inventing a
    // region taxonomy before there is a second region is speculative. See CLAUDE.md and the
    // Ticket's own notes.
    //
    // Nullable, and with no default, because "not stated" has to be representable in a saved
    // row. `sectors`, `stages` and `excluded_sectors` each say that with an empty array, and
    // `area` had no way to say it at all: `NOT NULL DEFAULT 'Bay Area'` meant every row that
    // existed stated an area whether its User had chosen one or not, so saving any preference
    // switched on area ranking at weight 1 and quietly reordered the Deck. `db/deck.ts` worked
    // around it by treating a *missing row* as `area: ""`, which left a saved row with nothing
    // stated impossible to express. Null is that state. See docs/adr/0011 and Ticket #191.
    area: text("area"),
    excludedSectors: text("excluded_sectors")
      .array()
      .$type<Sector[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    /**
     * The database's own half of the Sector vocabulary being closed, matching
     * `profiles_sector_is_controlled`: `sectors` and `excluded_sectors` can only ever hold
     * values from the closed list, even for a write that reaches Postgres some way other than
     * this app's own Zod boundary. `<@` is "is contained by".
     */
    check(
      "user_profiles_sectors_are_controlled",
      sql.raw(`sectors <@ array[${sectorLiterals}]::text[]`),
    ),
    check(
      "user_profiles_excluded_sectors_are_controlled",
      sql.raw(`excluded_sectors <@ array[${sectorLiterals}]::text[]`),
    ),
    /**
     * A Sector cannot be both stated and excluded at once — the rule the Ticket asks be
     * enforced rather than documented. `&&` is array overlap: true when the two sets share at
     * least one element.
     */
    check(
      "user_profiles_sectors_excluded_disjoint",
      sql`not (${table.sectors} && ${table.excludedSectors})`,
    ),
    /**
     * The only way to read or write a User Profile is to be signed in as its owner, matching
     * the pattern `profiles` and `swipes` already use.
     */
    pgPolicy("user_profiles_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
    }),
    pgPolicy("user_profiles_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.userId}`,
    }),
    pgPolicy("user_profiles_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
      withCheck: sql`${authUid} = ${table.userId}`,
    }),
  ],
);

export type UserProfileRow = typeof userProfiles.$inferSelect;
export type NewUserProfileRow = typeof userProfiles.$inferInsert;

/**
 * Every article News has read, stored once whoever it turns out to be about.
 *
 * The articles and the attributions are apart, per docs/adr/0022. This table is the article: one
 * row per `url`, written whether or not it matches a single Company Profile. `news_items` below
 * is the attribution, written only for a pair the matcher scored above zero.
 *
 * Keeping the ones that match nothing is what lets a Company Profile entering the Catalogue next
 * month be scored, on its first run, against everything already read — so it arrives with its
 * News instead of waiting for the next thing published about it. It is also the half of
 * docs/adr/0010's reasoning that survives: the articles are all still here for a retuned rule to
 * re-score, without fetching anything again.
 *
 * History search results are here too, since docs/adr/0024, and they carry
 * `searched_for_profile_id` so that docs/adr/0018's rule survives the move: a search result is
 * scored against the Company Profile it was searched for and no other, on this run and on every
 * later one. A feed or Launch HN article leaves the column null, which means the opposite — this
 * article belongs to the whole Catalogue and is scored against every Profile.
 */
export const newsArticles = pgTable(
  "news_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** Half of what the matcher reads, as on `news_items`. */
    description: text("description"),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** The publication, as the feed it came from names it: "Techmeme", not a hostname. */
    sourceName: text("source_name").notNull(),
    /**
     * The Company Profile a history search found this article for, or null when a feed or Launch
     * HN read it. Written once, when the row is first stored, and never updated: an article a
     * feed carried first is Catalogue, and a search finding the same url later does not narrow
     * it. See docs/adr/0024.
     */
    searchedForProfileId: uuid("searched_for_profile_id").references(
      () => profiles.id,
      { onDelete: "cascade" },
    ),
    /** When this article was first read. Not touched when a later run reads it again. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** As on `news_items`: the ingest role bypasses RLS here but not a check constraint. */
    check("news_articles_url_is_http", sql.raw("url ~ '^https?://'")),
    /**
     * The natural key: one row per article, however many runs or feeds carry it. Globally and
     * not per Company Profile, which is the whole point of the table.
     */
    uniqueIndex("news_articles_url_idx").on(table.url),
    /** Scoring a new Company Profile against the stored articles reads them newest first. */
    index("news_articles_published_at_idx").on(table.publishedAt.desc()),
    /**
     * Catalogue, readable by any signed-in User, as `news_items` is — although nothing in the
     * app reads this table yet: the page reads attributions. There is no insert or update
     * policy for `authenticated`; ingest is the only writer, per docs/adr/0013.
     */
    pgPolicy("news_articles_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    ...ingestPolicies("news_articles"),
  ],
);

export type NewsArticleRow = typeof newsArticles.$inferSelect;
export type NewNewsArticleRow = typeof newsArticles.$inferInsert;

/**
 * Which Company Profiles a News run has already taken care of: scored against every stored
 * `news_articles` row, and searched for over `HISTORY_WINDOW_DAYS` of Hacker News.
 *
 * Recorded rather than inferred from whether the Profile has `news_items` rows, because finding
 * nothing is the ordinary outcome for a two-person company, and inferring it would mean
 * searching for that company again every day forever. A row means both halves happened and the
 * write that followed them succeeded; a search that failed, or a Profile the run's cap never
 * reached, leaves no row and is tried again. See docs/adr/0022.
 */
export const newsProfileCoverage = pgTable(
  "news_profile_coverage",
  {
    profileId: uuid("profile_id")
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    coveredAt: timestamp("covered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [
    /** Catalogue: a statement about a Company Profile, which is Catalogue. See docs/adr/0019. */
    pgPolicy("news_profile_coverage_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    /**
     * Select and insert only, and no update policy or grant: a Profile is covered once and the
     * row never changes. `ingestPolicies` is not used here for that reason — an update right
     * nothing exercises is one nobody would notice being exercised.
     */
    pgPolicy("news_profile_coverage_ingest_select", {
      for: "select",
      to: ingestRole,
      using: sql`true`,
    }),
    pgPolicy("news_profile_coverage_ingest_insert", {
      for: "insert",
      to: ingestRole,
      withCheck: sql`true`,
    }),
  ],
);

export type NewsProfileCoverageRow = typeof newsProfileCoverage.$inferSelect;

/**
 * Which Company Profiles have had their own-site search run again under the news-only rule.
 *
 * `news_profile_coverage` above says a Profile's first run happened, and under docs/adr/0022
 * that was for good: searched for once ever. Everything the `site` query found before
 * docs/adr/0024 was scored by `scoreNewsMatch` alone, which scores a company's own post 0, and a
 * 0 was stored nowhere — so those articles were dropped and the Profile was never searched
 * again. This table is how they are recovered: one more `site` query per already-covered
 * Profile, once, with the result kept this time.
 *
 * A second table rather than a column on `news_profile_coverage`, because that table is
 * insert-only by grant and by design — ingest may not update it at all — and because the two
 * facts are different: one says a Profile has been covered, the other says a past coverage has
 * been repaired. A row here is written only when the re-search succeeded and the write that
 * followed it did; a failed re-search leaves none and is retried on a later run.
 */
export const newsProfileSiteRecovery = pgTable(
  "news_profile_site_recovery",
  {
    profileId: uuid("profile_id")
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    recoveredAt: timestamp("recovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [
    /** Catalogue, and on exactly `news_profile_coverage`'s terms: see its policies above. */
    pgPolicy("news_profile_site_recovery_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    pgPolicy("news_profile_site_recovery_ingest_select", {
      for: "select",
      to: ingestRole,
      using: sql`true`,
    }),
    pgPolicy("news_profile_site_recovery_ingest_insert", {
      for: "insert",
      to: ingestRole,
      withCheck: sql`true`,
    }),
  ],
);

export type NewsProfileSiteRecoveryRow =
  typeof newsProfileSiteRecovery.$inferSelect;

/**
 * News: an article attributed to a Company Profile, one row per pair.
 *
 * A pair the matcher scored above zero, with that `confidence` beside it. Which of them a User
 * sees is decided when reading, against `NEWS_DISPLAY_THRESHOLD`, never when writing: the first
 * threshold will be wrong, and an article dropped at fetch time is one that retuning cannot
 * bring back without fetching it again. See docs/adr/0010, and docs/adr/0022 for why the pairs
 * scoring exactly zero stopped being rows while the articles themselves are all kept, in
 * `news_articles` above.
 */
export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The Company Profile the matcher attributed this article to. */
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Stored although nothing displays it yet: it is half of what the matcher read, so a
     * retuned rule can re-score what is already here. */
    description: text("description"),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** The publication, as the feed it came from names it: "Techmeme", not a hostname. */
    sourceName: text("source_name").notNull(),
    /** From `scoreNewsMatch` in `lib/news/match.ts`. Double precision rather than `real`, so
     * a score of exactly 0.6 compares equal to a threshold of 0.6. */
    confidence: doublePrecision("confidence").notNull(),
    /** When this article was first stored. Not touched when a later run updates the row. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "news_items_confidence_is_a_proportion",
      sql.raw("confidence >= 0 and confidence <= 1"),
    ),
    /**
     * The page renders `url` as a link, and the ingest role bypasses RLS on this table but not a
     * check constraint, so a `javascript:` URL cannot reach an `href` through it.
     */
    check("news_items_url_is_http", sql.raw("url ~ '^https?://'")),
    /**
     * The natural key News ingest is idempotent on: an attribution is stored once per Company
     * Profile, however many runs return it. Per Company Profile rather than globally, because
     * one article about two companies is news about each. See docs/adr/0010.
     */
    uniqueIndex("news_items_profile_id_url_idx").on(table.profileId, table.url),
    /** The News page reads items newest first. */
    index("news_items_published_at_idx").on(table.publishedAt.desc()),
    /**
     * Read-only to the app, and readable by any signed-in User: an attribution is Catalogue,
     * like the article it is about — docs/adr/0019. There is no insert or update policy for
     * `authenticated`: nothing in the app writes News, only the ingest script, as the ingest
     * role — docs/adr/0013.
     */
    pgPolicy("news_items_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    ...ingestPolicies("news_items"),
  ],
);

export type NewsItem = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;

/**
 * The Diary's Events. An Event exists in its own right, per CONTEXT.md: `YC Demo Day` is one
 * row that many companies attend, not one row per attending company, which is why attendance
 * is a join table below rather than a column here.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which ingest path wrote this row, as on `profiles`: `techmeme-events`, and so on. */
    source: text("source").notNull(),
    /**
     * The Source's own identifier for the Event: an iCalendar `UID`, a JSON-LD `@id`. Both
     * events Sources publish one, which is what ADR 0008 found `profiles` had no field for;
     * here it exists, and it survives a Source correcting an Event's name or moving its date,
     * which a key on the name would not. Half the natural key below.
     */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** Calendar dates in the Event's own local time, not instants: a Diary is read by day. */
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    location: text("location"),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "events_end_date_not_before_start_date",
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`,
    ),
    /**
     * The natural key events ingest is idempotent on, and a constraint rather than a
     * convention for the reason `profiles` gives: the write path bypasses RLS.
     */
    uniqueIndex("events_source_external_id_idx").on(
      table.source,
      table.externalId,
    ),
    /** The Diary reads in date order. */
    index("events_start_date_idx").on(table.startDate),
    /** An Event is Catalogue: the same row for every User. See docs/adr/0019. */
    pgPolicy("events_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    ...ingestPolicies("events"),
  ],
);

/**
 * A Company Profile a Source states takes part in an Event. Many-to-many: one Event has many
 * companies and one company many Events. Only ever what a Source states, never inferred — see
 * `eventInputSchema.attendees`.
 */
export const eventAttendances = pgTable(
  "event_attendances",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.profileId] }),
    /** The other direction: every Event one Company Profile attends. */
    index("event_attendances_profile_id_idx").on(table.profileId),
    /**
     * Visible exactly when both ends are, which is now always: an Attendance is a statement
     * about an Event and a Company Profile, both Catalogue, so it is Catalogue too — see
     * docs/adr/0019. Written as `true` rather than as the two `exists` clauses it replaces,
     * because those read `events` and `profiles` through policies that now say `true`
     * themselves, and a check that cannot fail reads as one that can. There is no write
     * policy for `authenticated`: ingest is the only writer.
     */
    pgPolicy("event_attendances_select_catalogue", {
      for: "select",
      to: authenticatedRole,
      using: sql`true`,
    }),
    ...ingestPolicies("event_attendances"),
    /**
     * The one delete ingest may make anywhere. `persistEvents` replaces an Event's Attendance
     * wholesale on every run, so a company a Source stops naming stops being linked.
     */
    pgPolicy("event_attendances_ingest_delete", {
      for: "delete",
      to: ingestRole,
      using: sql`true`,
    }),
  ],
);
