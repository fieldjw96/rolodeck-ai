import "server-only";

import { getDb } from "../../db/connection";
import { asUser } from "../../db/rls";
import { readSavedUserProfile } from "../../db/user-profile";

/**
 * True for a User who has never saved a User Profile — stated or skipped — and so has never
 * been asked for Sectors and Stages. Skipping still writes the row (`writeUserProfile` in
 * `db/user-profile.ts`), so row existence is the record of having been asked, not what the row
 * holds: an owner who skipped reads exactly as asked as one who stated three Sectors. See
 * Ticket #191 and docs/adr/0011.
 */
export async function needsOnboarding(userId: string): Promise<boolean> {
  const saved = await asUser(getDb(), userId, (tx) =>
    readSavedUserProfile(tx, userId),
  );

  return saved === null;
}
