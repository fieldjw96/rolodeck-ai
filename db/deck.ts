import {
  and,
  desc,
  eq,
  inArray,
  notExists,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
 * The Profile as the Deck deals it. `source` and `name_key` are left out because they are
 * ingest's bookkeeping — which pipeline wrote the row and what it deduplicates on — and say
 * nothing about the company on the card. `founders` and `links` are dealt as stored, null
 * where the Source stated none, for the card's Team and Contact tabs.
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
  "source" | "nameKey" | "foundersSoughtAt"
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

const weighted = (matches: SQL, weight: number) =>
  sql`case when ${matches} then ${weight}::int else 0 end`;

/**
 * A Company Profile's score under `userProfile`, as SQL, so the Deck is ordered inside
 * Postgres rather than by fetching every row. Each unstated preference compiles to `false` and
 * adds nothing, which is how a User Profile that states nothing deals the Deck newest-first
 * without anyone checking for it: an empty array for the three list preferences, and a null
 * `area`, which `citiesInArea` answers with no cities.
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
 * A Company Profile's siblings: the rows sharing its `name_key`, which is one company found by
 * more than one Source. `(source, name_key)` is the Catalogue's key, so two Sources that both
 * found a company are two rows and stay two rows — docs/adr/0008 defers merging them, and
 * nothing here merges them. What the surfaces below do is deal, Keep and group a company once,
 * by reading its siblings as one. Aliases, because every such clause is `profiles` joined to
 * itself.
 */
const sibling = alias(profiles, "sibling");
const siblingSwipe = alias(swipes, "sibling_swipe");

/**
 * Has this reader decided nothing yet about the company on the current row, under any of its
 * Sources? A Keep or a Pass on one sibling speaks for every sibling, which is what keeps a
 * company a reader has already judged from coming back under its other Source's row.
 *
 * `userId` is written into the subquery, as the single-row swipe clause it replaces wrote it:
 * per CLAUDE.md the RLS policies are a backstop and never the only control.
 */
const undecidedBy = (db: Database, userId: string) =>
  notExists(
    db
      .select({ decided: sql`1` })
      .from(siblingSwipe)
      .innerJoin(sibling, eq(sibling.id, siblingSwipe.profileId))
      .where(
        and(
          eq(siblingSwipe.userId, userId),
          eq(sibling.nameKey, profiles.nameKey),
        ),
      ),
  );

/**
 * One page of the Deck: the whole Catalogue of Company Profiles, minus the ones this reader has
 * already Kept or Passed and the ones in a Sector their User Profile excludes, ranked by that
 * User Profile and newest first within a rank. Ranked rather than filtered: a Profile matching
 * nothing the reader stated is still dealt, at the bottom. See docs/adr/0011.
 *
 * One card per company, not one per Source: of the siblings a Sector exclusion leaves, the
 * first by the Deck's own order is dealt and the rest are not, however the pages are cut. The
 * ranking happens in the subquery because the window that picks the winner has to see the same
 * score the page is ordered by; the cursor then pages over the winners alone, and its
 * `(score, created_at, id)` is as unique among them as it was over the whole Catalogue.
 *
 * Every User deals from the same Catalogue, per docs/adr/0019. What makes one reader's Deck
 * differ from another's is their own swipes and their own User Profile, both of which are
 * written out in this query against `userId` rather than left to RLS: per CLAUDE.md the
 * policies are a backstop and never the only control, and neither the swipe exclusion nor the
 * ranking is something RLS could express in the first place.
 */
export async function readDeckPage(
  db: Database,
  {
    userId,
    limit,
    cursor,
  }: { userId: string; limit: number; cursor?: DeckCursor },
): Promise<DeckPage> {
  // `EMPTY_USER_PROFILE` is now safe to rank by, which it was not while its `area` was
  // "Bay Area": a User who has saved nothing and a User with no row at all state the same
  // nothing, and both deal the Deck newest-first. See docs/adr/0011.
  const userProfile =
    (await readSavedUserProfile(db, userId)) ?? EMPTY_USER_PROFILE;
  const score = deckScore(userProfile);

  /**
   * Every Company Profile this reader could still be dealt, each carrying its score and its
   * place among its siblings. `sibling_rank` is 1 for the one sibling that stands for the
   * company and counts up through the rest.
   *
   * The swipe clause sits here rather than outside because it answers for a whole company at
   * once — every sibling or none — so it cannot change which sibling wins, only whether the
   * company is dealt at all.
   */
  const dealable = db
    .select({
      // Nested, so the page below hands the whole card back out without naming its columns a
      // second time — and so `name_key`, which the window has to partition by, stays beside
      // the card rather than in it. No caller may see it; see `deckColumns`.
      profile: deckColumns,
      nameKey: profiles.nameKey,
      score: score.as("score"),
      siblingRank:
        sql<number>`row_number() over (partition by ${profiles.nameKey} order by ${score} desc, ${profiles.createdAt} desc, ${profiles.id} desc)`.as(
          "sibling_rank",
        ),
    })
    .from(profiles)
    .where(
      and(
        notInArray(profiles.sector, userProfile.excludedSectors),
        undecidedBy(db, userId),
      ),
    )
    .as("dealable");

  // One more row than asked for: whether it comes back is the whole of the "is there a next
  // page?" question, and it costs one row rather than a second count query.
  const rows = await db
    .select({ profile: dealable.profile, score: dealable.score })
    .from(dealable)
    .where(
      and(
        sql`${dealable.siblingRank} = 1`,
        cursor === undefined
          ? undefined
          : sql`(${dealable.score}, ${dealable.profile.createdAt}, ${dealable.profile.id}) < (${cursor.score}::int, ${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      ),
    )
    .orderBy(
      desc(dealable.score),
      desc(dealable.profile.createdAt),
      desc(dealable.profile.id),
    )
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
 * Is the swipe on the current row this reader's newest decision about the company — the one
 * that counts for all of its Sources' rows? For a query that has `profiles` joined to the
 * reader's `swipes`, which is how both the Watchlist and the News page read a Keep. Pair it
 * with `decision = 'keep'` and what survives is one row per company, or none where the reader's
 * newest word on it was a Pass.
 *
 * That is what makes a Pass cover a sibling Kept before this collapsing existed: the Pass is
 * newer, so the older Keep is not the decision that counts and the company leaves the Watchlist
 * and the News page together. Two Keeps can tie on `decided_at`, since a reader could have Kept
 * both siblings in one statement, which is why `(decided_at, id)` is compared as a pair: one of
 * them still has to win.
 *
 * `userId` is written into the subquery as it is into the join outside: per CLAUDE.md the RLS
 * policies are a backstop and never the only control.
 */
export const isNewestDecisionForCompany = (db: Database, userId: string) =>
  notExists(
    db
      .select({ newer: sql`1` })
      .from(siblingSwipe)
      .innerJoin(sibling, eq(sibling.id, siblingSwipe.profileId))
      .where(
        and(
          eq(siblingSwipe.userId, userId),
          eq(sibling.nameKey, profiles.nameKey),
          sql`(${siblingSwipe.decidedAt}, ${sibling.id}) > (${swipes.decidedAt}, ${profiles.id})`,
        ),
      ),
  );

/**
 * Every company the reader currently Keeps, newest decision first, and one entry each however
 * many Sources found it: the Company Profile the Keep that counts was recorded against. Unlike
 * `readDeckPage` this is not paginated: the Watchlist is meant to show everything in one place,
 * and per the Ticket paging it is out of scope.
 *
 * The Company Profiles are Catalogue and shared; the Keeps are not. So the reader is written
 * into the join on `swipes.user_id` and into the clause above, and nowhere else, which is the
 * whole of what makes this one User's Watchlist rather than everybody's. See docs/adr/0019.
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
    .where(
      and(
        eq(swipes.decision, "keep"),
        isNewestDecisionForCompany(db, userId),
      ),
    )
    .orderBy(desc(swipes.decidedAt), desc(profiles.id));
}

export type SwipeRecord = {
  profileId: string;
  decision: SwipeDecision;
  decidedAt: Date;
};

/**
 * Records a Keep or a Pass, or returns null when there is no such Company Profile.
 *
 * Every Company Profile is visible to every signed-in User now that the Catalogue is shared
 * (docs/adr/0019), so this asks whether the row exists rather than who holds it. That is still
 * worth asking: without it a made-up id would come back as a foreign key violation — a 500 —
 * rather than as the 404 the route turns a null into. The insert policy in `db/schema.ts`
 * makes the same check underneath, in its `exists` clause.
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
    .where(eq(profiles.id, profileId))
    .limit(1);

  if (visible === undefined) {
    return null;
  }

  // Swiping the same Profile again is a correction rather than a second decision, so the
  // primary key is the conflict target and the newer decision wins. One row, about the one
  // Company Profile swiped: the siblings it also speaks for are joined to it on `name_key` by
  // the reads above, so a decision covers a company it was never written against — including
  // one whose other Source's row was swiped before any of this existed.
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
