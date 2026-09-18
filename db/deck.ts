import { and, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { citiesInArea } from "../lib/location/bay-area";
import type { Database } from "./connection";
import { profiles, swipes, type Profile, type SwipeDecision } from "./schema";
import {
  EMPTY_USER_PROFILE,
  readSavedUserProfile,
  type UserProfile,
} from "./user-profile";

/** The Deck's page size when a request does not ask for one, and the most it may ask for. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * What each stated preference a Company Profile matches adds to its score, and so to how early
 * the Deck deals it. The one place the weights live. Powers of two, so no two different sets of
 * matches ever tie: a Sector match outranks a Stage and an area match together. A Company
 * Profile matching nothing scores 0 and is still dealt, last. See docs/adr/0011.
 */
export const DECK_RANK_WEIGHTS = { sector: 4, stage: 2, area: 1 } as const;

const MAX_DECK_SCORE =
  DECK_RANK_WEIGHTS.sector + DECK_RANK_WEIGHTS.stage + DECK_RANK_WEIGHTS.area;

/**
 * Where a page of the Deck resumes: the whole of the order the last Profile dealt was in. The
 * Deck is ordered by score, then newest first, and neither is unique, so the id goes in the
 * cursor as the final tiebreak. Every column of the order has to be here — leave the score out
 * and a page would resume from the right age at the wrong rank, repeating some Profiles and
 * never dealing others.
 */
export type DeckCursor = { score: number; createdAt: Date; id: string };

const CURSOR_SEPARATOR = " ";

/**
 * The cursor is opaque to the client on purpose: base64 says "this is ours, hand it back
 * unchanged" rather than inviting a caller to build one, and `decodeCursor` treats whatever
 * comes back as hostile anyway.
 */
export function encodeCursor(cursor: DeckCursor): string {
  return Buffer.from(
    [cursor.score, cursor.createdAt.toISOString(), cursor.id].join(
      CURSOR_SEPARATOR,
    ),
    "utf8",
  ).toString("base64url");
}

// `z.guid()` rather than `z.uuid()`: Postgres's `uuid` type accepts any 128 bits laid out as
// hex, and a boundary that is stricter than the column it guards would reject an id the
// database itself is perfectly happy to hold.
const cursorPartsSchema = z.tuple([
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().max(MAX_DECK_SCORE)),
  z.iso.datetime(),
  z.guid(),
]);

/** The cursor a request sent back, or null if it is not one this endpoint could have issued. */
export function decodeCursor(raw: string): DeckCursor | null {
  // Base64 decoding is lenient — it drops characters it does not recognise rather than
  // failing — so the parse below, not the decode, is what rejects a made-up cursor.
  const parts = cursorPartsSchema.safeParse(
    Buffer.from(raw, "base64url").toString("utf8").split(CURSOR_SEPARATOR),
  );

  if (!parts.success) {
    return null;
  }

  return {
    score: parts.data[0],
    createdAt: new Date(parts.data[1]),
    id: parts.data[2],
  };
}

/**
 * The `filter` param of `GET /api/profiles`, checked on its own and before paging is
 * considered at all: a caller asking for `filter=kept` gets the Watchlist regardless of
 * what `limit` or `cursor` it also sent, since the Watchlist ignores both — see
 * `readKeptProfiles`.
 */
export const filterQuerySchema = z.object({
  filter: z.enum(["kept"], { error: "must be 'kept'" }).optional(),
});

/**
 * `limit` and `cursor`, the Deck's own paging params — parsed only once a request is known
 * not to be `filter=kept`, so a Watchlist caller is never 422'd over paging it does not use.
 * `limit` is clamped by rejection rather than by silently capping, so a caller asking for 500
 * Profiles is told no instead of quietly getting 50.
 */
export const pagingQuerySchema = z.object({
  limit: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number of Profiles")
    .min(1, "must be at least 1")
    .max(MAX_PAGE_SIZE, `must not be more than ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
  cursor: z
    .string()
    .transform((raw, ctx) => {
      const cursor = decodeCursor(raw);

      if (cursor === null) {
        ctx.addIssue({
          code: "custom",
          message: "is not a cursor this endpoint issued",
        });
        return z.NEVER;
      }

      return cursor;
    })
    .optional(),
});

/**
 * The Profile as the Deck deals it. `owner_id` is left out because it is always the reader;
 * `source` and `name_key` because they are ingest's bookkeeping — which pipeline wrote the row
 * and what it deduplicates on — and say nothing about the company on the card. `founders` and
 * `links` are dealt as stored, null where the Source stated none, for the card's Team and
 * Contact tabs.
 */
const deckColumns = {
  id: profiles.id,
  name: profiles.name,
  description: profiles.description,
  sector: profiles.sector,
  stage: profiles.stage,
  website: profiles.website,
  location: profiles.location,
  founders: profiles.founders,
  links: profiles.links,
  provenance: profiles.provenance,
  createdAt: profiles.createdAt,
};

// `foundersSoughtAt` records what ingest did, not anything about the company, so the Deck
// neither reads nor shows it. See docs/adr/0016.
export type DeckProfile = Omit<
  Profile,
  "ownerId" | "source" | "nameKey" | "foundersSoughtAt"
>;

export type DeckPage = {
  profiles: DeckProfile[];
  /** Null on the last page, which is how a caller knows the Deck is exhausted. */
  nextCursor: string | null;
};

/**
 * `location`'s city as `isBayArea` reads it in `lib/location/bay-area.ts`: everything before
 * the first comma, trimmed and case-folded, and null for a location with no comma — a bare
 * state names no city. The ranking tests hold this and `isBayArea` to the same answers.
 */
const locationCity = sql`case when strpos(${profiles.location}, ',') > 0 then lower(regexp_replace(split_part(${profiles.location}, ',', 1), '^[[:space:]]+|[[:space:]]+$', '', 'g')) end`;

/**
 * What the Deck ranks by for an owner who has never saved a User Profile: nothing, so it deals
 * newest-first. Not `EMPTY_USER_PROFILE` itself, whose `area` is the settings form's starting
 * value rather than a place anybody chose — ranking by it would reorder a Deck whose owner has
 * stated nothing. See docs/adr/0011.
 */
const NOTHING_STATED: UserProfile = { ...EMPTY_USER_PROFILE, area: "" };

const weighted = (matches: SQL, weight: number) =>
  sql`case when ${matches} then ${weight}::int else 0 end`;

/**
 * A Company Profile's score under `userProfile`, as SQL, so the Deck is ordered inside
 * Postgres rather than by fetching every row. Each empty preference compiles to `false` and
 * adds nothing, which is how a User Profile that states nothing deals the Deck newest-first
 * without anyone checking for it.
 */
function deckScore(userProfile: UserProfile): SQL<number> {
  return sql<number>`(${weighted(
    inArray(profiles.sector, userProfile.sectors),
    DECK_RANK_WEIGHTS.sector,
  )} + ${weighted(
    inArray(profiles.stage, userProfile.stages),
    DECK_RANK_WEIGHTS.stage,
  )} + ${weighted(
    inArray(locationCity, [...citiesInArea(userProfile.area)]),
    DECK_RANK_WEIGHTS.area,
  )})`.mapWith(Number);
}

/**
 * One page of the Deck: the reader's own Profiles, minus the ones they have already Kept or
 * Passed and the ones in a Sector their User Profile excludes, ranked by that User Profile and
 * newest first within a rank. Ranked rather than filtered: a Profile matching nothing the
 * owner stated is still dealt, at the bottom. See docs/adr/0011.
 *
 * Ownership and the swipe exclusion are both written out here rather than left to RLS. Per
 * CLAUDE.md the policies are a backstop and never the only control, and the exclusion is not
 * something RLS could express in the first place.
 */
export async function readDeckPage(
  db: Database,
  {
    userId,
    limit,
    cursor,
  }: { userId: string; limit: number; cursor?: DeckCursor },
): Promise<DeckPage> {
  const userProfile =
    (await readSavedUserProfile(db, userId)) ?? NOTHING_STATED;
  const score = deckScore(userProfile);

  // One more row than asked for: whether it comes back is the whole of the "is there a next
  // page?" question, and it costs one row rather than a second count query.
  const rows = await db
    .select({ profile: deckColumns, score })
    .from(profiles)
    .where(
      and(
        eq(profiles.ownerId, userId),
        notInArray(profiles.sector, userProfile.excludedSectors),
        sql`not exists (select 1 from ${swipes} where ${swipes.profileId} = ${profiles.id} and ${swipes.userId} = ${userId})`,
        cursor === undefined
          ? undefined
          : sql`(${score}, ${profiles.createdAt}, ${profiles.id}) < (${cursor.score}::int, ${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(score), desc(profiles.createdAt), desc(profiles.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    profiles: page.map((row) => row.profile),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({
            score: last.score,
            createdAt: last.profile.createdAt,
            id: last.profile.id,
          })
        : null,
  };
}

/**
 * Every Profile the reader has Kept, newest decision first. Unlike `readDeckPage` this is not
 * paginated: the Watchlist is meant to show everything in one place, and per the Ticket
 * paging it is out of scope.
 *
 * Ownership is written out in the `where` clause as well as carried by the join and the RLS
 * policy, matching `readDeckPage` — see CLAUDE.md on RLS as a backstop, never the only
 * control.
 */
export async function readKeptProfiles(
  db: Database,
  userId: string,
): Promise<DeckProfile[]> {
  return db
    .select(deckColumns)
    .from(profiles)
    .innerJoin(
      swipes,
      and(eq(swipes.profileId, profiles.id), eq(swipes.userId, userId)),
    )
    .where(and(eq(profiles.ownerId, userId), eq(swipes.decision, "keep")))
    .orderBy(desc(swipes.decidedAt), desc(profiles.id));
}

export type SwipeRecord = {
  profileId: string;
  decision: SwipeDecision;
  decidedAt: Date;
};

/**
 * Records a Keep or a Pass, or returns null when the Profile is not one this user can see.
 *
 * The visibility check is not ceremony: a foreign key does not consult RLS, so an id
 * belonging to somebody else would otherwise be accepted and would sit in `swipes` for ever.
 * The insert policy in `db/schema.ts` refuses the same write underneath.
 */
export async function recordSwipe(
  db: Database,
  {
    userId,
    profileId,
    decision,
  }: { userId: string; profileId: string; decision: SwipeDecision },
): Promise<SwipeRecord | null> {
  const [visible] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, userId)))
    .limit(1);

  if (visible === undefined) {
    return null;
  }

  // Swiping the same Profile again is a correction rather than a second decision, so the
  // primary key is the conflict target and the newer decision wins.
  const [recorded] = await db
    .insert(swipes)
    .values({ userId, profileId, decision })
    .onConflictDoUpdate({
      target: [swipes.userId, swipes.profileId],
      set: { decision, decidedAt: sql`now()` },
    })
    .returning({
      profileId: swipes.profileId,
      decision: swipes.decision,
      decidedAt: swipes.decidedAt,
    });

  // The insert either returns its row or raises; a policy that refused it would have thrown.
  return recorded ?? null;
}
