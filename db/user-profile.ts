import { eq } from "drizzle-orm";

import type { Database } from "./connection";
import type { Sector, Stage } from "./profile-input";
import { userProfiles } from "./schema";
import type { UserProfileInput } from "./user-profile-input";

export type UserProfile = {
  sectors: Sector[];
  stages: Stage[];
  area: string;
  excludedSectors: Sector[];
};

/**
 * What a User Profile is before the owner has ever saved one: every set empty, `area` at its
 * one supported value. This is what `readUserProfile` returns for a never-saved owner, rather
 * than null or a thrown error, so a first-run app is not a special case scattered through the
 * callers — see the Ticket's own notes.
 */
export const EMPTY_USER_PROFILE: UserProfile = {
  sectors: [],
  stages: [],
  area: "Bay Area",
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
 * The owner's User Profile as they last saved it, or null if they never have. For a reader
 * that has to tell "never said anything" from "said the defaults" — the Deck, which does not
 * rank by `EMPTY_USER_PROFILE`'s `area` because nobody chose it. See docs/adr/0011.
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
