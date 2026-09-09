import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./connection";
import { profiles, swipes, type Profile, type SwipeDecision } from "./schema";

/** The Deck's page size when a request does not ask for one, and the most it may ask for. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Where a page of the Deck resumes. The Deck is ordered newest Profile first, and `created_at`
 * alone is not unique, so the id goes in the cursor as the tiebreak — without it two Profiles
 * written in the same millisecond could straddle a page boundary and one of them would never
 * be dealt.
 */
export type DeckCursor = { createdAt: Date; id: string };

const CURSOR_SEPARATOR = " ";

/**
 * The cursor is opaque to the client on purpose: base64 says "this is ours, hand it back
 * unchanged" rather than inviting a caller to build one, and `decodeCursor` treats whatever
 * comes back as hostile anyway.
 */
export function encodeCursor(cursor: DeckCursor): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

// `z.guid()` rather than `z.uuid()`: Postgres's `uuid` type accepts any 128 bits laid out as
// hex, and a boundary that is stricter than the column it guards would reject an id the
// database itself is perfectly happy to hold.
const cursorPartsSchema = z.tuple([z.iso.datetime(), z.guid()]);

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

  return { createdAt: new Date(parts.data[0]), id: parts.data[1] };
}

/**
 * The query string of `GET /api/profiles`, which is external input like any other. `limit`
 * and `cursor` page the Deck; `filter` switches the endpoint to the Watchlist instead, which
 * has no paging of its own — see `readKeptProfiles`. `limit` is clamped by rejection rather
 * than by silently capping, so a caller asking for 500 Profiles is told no instead of quietly
 * getting 50.
 */
export const deckQuerySchema = z.object({
  filter: z.enum(["kept"], { error: "must be 'kept'" }).optional(),
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

/** The Profile as the Deck deals it: everything but `owner_id`, which is always the reader. */
const deckColumns = {
  id: profiles.id,
  name: profiles.name,
  description: profiles.description,
  sector: profiles.sector,
  stage: profiles.stage,
  website: profiles.website,
  provenance: profiles.provenance,
  createdAt: profiles.createdAt,
};

export type DeckProfile = Omit<Profile, "ownerId">;

export type DeckPage = {
  profiles: DeckProfile[];
  /** Null on the last page, which is how a caller knows the Deck is exhausted. */
  nextCursor: string | null;
};

/**
 * One page of the Deck: the reader's own Profiles, minus the ones they have already Kept or
 * Passed, newest first.
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
  // One more row than asked for: whether it comes back is the whole of the "is there a next
  // page?" question, and it costs one row rather than a second count query.
  const rows = await db
    .select(deckColumns)
    .from(profiles)
    .where(
      and(
        eq(profiles.ownerId, userId),
        sql`not exists (select 1 from ${swipes} where ${swipes.profileId} = ${profiles.id} and ${swipes.userId} = ${userId})`,
        cursor === undefined
          ? undefined
          : sql`(${profiles.createdAt}, ${profiles.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(profiles.createdAt), desc(profiles.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    profiles: page,
    nextCursor:
      rows.length > limit && last !== undefined ? encodeCursor(last) : null,
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
