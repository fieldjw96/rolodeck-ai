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

import { SECTOR_VALUES, type Sector, type Stage } from "./profile-input";
import {
  PROVENANCE_VALUES,
  PROVENANCED_FIELDS,
  type ProfileProvenance,
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
 * Ingest writes rows owned by the account, not by itself, so no ownership policy could ever
 * match it; these admit it to one table outright. A policy is scoped to its table, so they
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

/** The Profile fields nullable enough that their provenance can be null too. */
const NULLABLE_FIELDS: readonly string[] = ["website", "location"];

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
    ...PROVENANCED_FIELDS.filter(
      (field) => !NULLABLE_FIELDS.includes(field),
    ).map(hasValidProvenance),
    // `website` and `location` are the two nullable Profile fields: each carries provenance
    // exactly when it has a value to attribute.
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
     * V1 is single-player, but every Profile is owned from day one so RLS has something to
     * match on and multi-user stays additive rather than a migration. See CLAUDE.md.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
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
     * The natural key ingest is idempotent on: one Profile per company name, per source, per
     * owner. It is a constraint rather than a convention because the write path runs as the
     * ingest role, which bypasses RLS on this table, and a duplicate it created would be
     * a second card for the same company in the Deck, not an error anything would raise. See
     * docs/adr/0008.
     */
    uniqueIndex("profiles_owner_id_source_name_key_idx").on(
      table.ownerId,
      table.source,
      table.nameKey,
    ),
    /**
     * Narrows `readDeckPage` to one owner's rows, newest first. It no longer carries the whole
     * `order by`: the Deck ranks by a score computed from the User Profile, which no index can
     * hold, and sorting one owner's rows is cheap at single-player volume. See docs/adr/0011.
     */
    index("profiles_owner_id_created_at_id_idx").on(
      table.ownerId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    /**
     * The only way to read a Profile is to be signed in as its owner. Defining any policy
     * makes Drizzle enable RLS on the table, so the anonymous role — which Supabase grants
     * table privileges to by default — matches no policy and sees no rows.
     */
    pgPolicy("profiles_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerId}`,
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
    area: text("area").notNull().default("Bay Area"),
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
 * News: articles about a Kept Company Profile, one row per article per Company Profile.
 *
 * Every candidate the provider returned is a row, however unlikely it is to be about the right
 * company, with the matcher's `confidence` beside it. Which of them the owner sees is decided
 * when reading, against `NEWS_DISPLAY_THRESHOLD`, never when writing: the first threshold will
 * be wrong, and a candidate dropped at fetch time is one that retuning cannot bring back
 * without fetching it again. See docs/adr/0010.
 */
export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The Company Profile the matcher attributed this article to. */
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    /**
     * Carried on the row, rather than reached through `profiles`, so the RLS policy below is a
     * plain equality like every other table's — the same reason `swipes` carries `user_id`.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Stored although nothing displays it yet: it is half of what the matcher read, so a
     * retuned rule can re-score what is already here. */
    description: text("description"),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** The publication, as the provider names it: "TechCrunch", not `gnews`. */
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
     * The natural key News ingest is idempotent on: an article is stored once per Company
     * Profile, however many runs return it. Per Company Profile rather than globally, because
     * one article about two Kept companies is news about each. See docs/adr/0010.
     */
    uniqueIndex("news_items_profile_id_url_idx").on(table.profileId, table.url),
    /** The News page reads one owner's items newest first. */
    index("news_items_owner_id_published_at_idx").on(
      table.ownerId,
      table.publishedAt.desc(),
    ),
    /**
     * Read-only to the app, and only to the owner. There is no insert or update policy for
     * `authenticated`: nothing in the app writes News, only the ingest script, as the ingest
     * role — docs/adr/0013.
     */
    pgPolicy("news_items_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerId}`,
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
    /** Owned from day one for the reason `profiles.owner_id` is. See CLAUDE.md. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
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
    uniqueIndex("events_owner_id_source_external_id_idx").on(
      table.ownerId,
      table.source,
      table.externalId,
    ),
    /** The Diary reads by owner in date order, so the index carries both. */
    index("events_owner_id_start_date_idx").on(table.ownerId, table.startDate),
    pgPolicy("events_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerId}`,
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
     * Visible exactly when both ends are. There is no owner column to match on, so the policy
     * reads `events` and `profiles` through their own policies instead, the way
     * `swipes_insert_own` does. There is no write policy for `authenticated`: ingest is the
     * only writer.
     */
    pgPolicy("event_attendances_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`exists (select 1 from ${events} where ${events.id} = ${table.eventId}) and exists (select 1 from ${profiles} where ${profiles.id} = ${table.profileId})`,
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
