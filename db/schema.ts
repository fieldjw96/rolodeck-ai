import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";

import {
  PROVENANCE_VALUES,
  PROVENANCED_FIELDS,
  type ProfileProvenance,
} from "./provenance";

const provenanceLiterals = PROVENANCE_VALUES.map((value) => `'${value}'`).join(
  ", ",
);

const hasValidProvenance = (field: string) =>
  `provenance ->> '${field}' in (${provenanceLiterals})`;

/**
 * The database's own half of the per-field provenance rule. Zod guards the boundary in
 * TypeScript; this guards it for anything that reaches Postgres another way, including the
 * service-role ingest path, which bypasses RLS but not a check constraint.
 */
const provenanceCoversEveryField = sql.raw(
  // A CHECK passes when it evaluates to NULL, and `null in (...)` is NULL, so a field with
  // no provenance key at all would slip through unwrapped. The coalesce is what turns a
  // missing field into a rejection rather than a silently unattributed value.
  `coalesce(\n  ${[
    ...PROVENANCED_FIELDS.filter((field) => field !== "website").map(
      hasValidProvenance,
    ),
    // `website` is the one nullable Profile field: it carries provenance exactly when it
    // has a value to attribute.
    `(website is null) = (provenance ->> 'website' is null)`,
    `(website is null or ${hasValidProvenance("website")})`,
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
    name: text("name").notNull(),
    description: text("description").notNull(),
    sector: text("sector").notNull(),
    stage: text("stage").notNull(),
    website: text("website"),
    provenance: jsonb("provenance").$type<ProfileProvenance>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("profiles_provenance_covers_every_field", provenanceCoversEveryField),
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
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
