import { eq } from "drizzle-orm";

import type { Database } from "./connection";
import type { Sector, Stage } from "./profile-input";
import { userProfiles } from "./schema";
import type { UserProfileInput } from "./user-profile-input";

export type UserProfile = {
  sectors: Sector[];
  stages: Stage[];
  /** Null where the User has stated no area, which is a different claim from stating one. */
  area: string | null;
  excludedSectors: Sector[];
};

/**
 * What a User Profile is before a User has stated anything: every set empty and no area. This
 * is what `readUserProfile` returns for a User who has never saved one, rather than null or a
 * thrown error, so a first-run app is not a special case scattered through the callers — see
 * the Ticket's own notes.
 *
 * `area` is null rather than "Bay Area" because nothing here was chosen by anybody, and the
 * Deck ranks on what was chosen. It used to be "Bay Area", which made this value unusable as a
 * ranking input and forced `db/deck.ts` to keep a second constant that blanked the area out.
 * That second constant is gone, and the one honest answer is here: see docs/adr/0011.
 */
export const EMPTY_USER_PROFILE: UserProfile = {
  sectors: [],
  stages: [],
  area: null,
  excludedSectors: [],
};

/** The owner's stated preferences, or `EMPTY_USER_PROFILE` if they have never saved one. */
export async function readUserProfile(
  db: Database,
  userId: string,
): Promise<UserProfile> {
  return (await readSavedUserProfile(db, userId)) ?? EMPTY_USER_PROFILE;
}

/**
 * A User's own User Profile as they last saved it, or null if they never have, for a reader
 * that has to tell "never saved anything" from "saved, and stated nothing". Those two now rank
 * the Deck identically, because `area` can be null in a saved row, so the distinction is no
 * longer load-bearing for ranking — but it is still what decides whether a User has been
 * through the first-run screen. See docs/adr/0011.
 */
export async function readSavedUserProfile(
  db: Database,
  userId: string,
): Promise<UserProfile | null> {
  const [row] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  return {
    sectors: row.sectors,
    stages: row.stages,
    area: row.area,
    excludedSectors: row.excludedSectors,
  };
}

/**
 * Writes an empty row for `userId` if it has none, and leaves an existing row exactly as it
 * was. Unlike `writeUserProfile`, this never overwrites — it is for
 * `scripts/provision-account.ts`, which must not reset a real User's stated preferences just
 * because rotating the smoke test's password happens to touch the same account again. See
 * Ticket #207 and migration `0015_backfill_user_profiles`, which is this same write for every
 * account that already existed when the first-run screen shipped.
 */
export async function ensureUserProfile(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ userId })
    .onConflictDoNothing({ target: userProfiles.userId });
}

/**
 * Writes the owner's stated preferences, replacing whatever was there before. An upsert
 * keyed on `user_id` rather than an insert: the owner has exactly one row, per the Ticket, so
 * a second `PUT` is a correction to the same row rather than a conflict a caller has to avoid.
 */
export async function writeUserProfile(
  db: Database,
  userId: string,
  input: UserProfileInput,
): Promise<UserProfile> {
  const values = {
    sectors: input.sectors,
    stages: input.stages,
    area: input.area,
    excludedSectors: input.excluded_sectors,
  };

  const [written] = await db
    .insert(userProfiles)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userProfiles.userId, set: values })
    .returning();

  // The insert either returns its row or raises; a policy that refused it would have thrown.
  return {
    sectors: written!.sectors,
    stages: written!.stages,
    area: written!.area,
    excludedSectors: written!.excludedSectors,
  };
}
