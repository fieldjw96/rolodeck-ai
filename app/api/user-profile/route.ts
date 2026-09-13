import type { NextRequest } from "next/server";

import { getDb } from "../../../db/connection";
import { asUser } from "../../../db/rls";
import {
  readUserProfile,
  writeUserProfile,
  type UserProfile,
} from "../../../db/user-profile";
import { userProfileInputSchema } from "../../../db/user-profile-input";
import { authenticated } from "../../../lib/api/authenticated";
import { unprocessable } from "../../../lib/api/responses";

/** The User Profile on the wire. Keys are the column names, matching `GET /api/profiles`. */
function toJson(profile: UserProfile) {
  return {
    sectors: profile.sectors,
    stages: profile.stages,
    area: profile.area,
    excluded_sectors: profile.excludedSectors,
  };
}

/**
 * A body that is not valid JSON at all — an empty `PUT`, or one that is not an object — is
 * undefined rather than a thrown parse error, so `userProfileInputSchema` is what rejects it,
 * naming the root rather than `authenticated()`'s catch-all turning it into a 500.
 */
async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Reads the owner's stated preferences: sectors, stages, area and exclusions. */
export const GET = authenticated(async (_request, user) => {
  const profile = await asUser(getDb(), user.id, (tx) =>
    readUserProfile(tx, user.id),
  );

  return Response.json(toJson(profile));
});

/** Replaces the owner's stated preferences with the body sent. */
export const PUT = authenticated(async (request, user) => {
  const parsed = userProfileInputSchema.safeParse(await readJsonBody(request));

  if (!parsed.success) {
    return unprocessable(parsed.error);
  }

  const written = await asUser(getDb(), user.id, (tx) =>
    writeUserProfile(tx, user.id, parsed.data),
  );

  return Response.json(toJson(written));
});
