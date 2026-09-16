import { z } from "zod";

import { sectorSchema, statedStageSchema } from "./profile-input";

/**
 * The one shared boundary schema for a User Profile write: the settings page's `PUT` and
 * nothing else, since the Ticket stores the owner's preferences and does not read them
 * anywhere. Requires all four fields, matching the settings page setting all four at once,
 * rather than a partial update no caller in this Ticket needs.
 */
export const userProfileInputSchema = z
  .strictObject({
    sectors: z.array(sectorSchema),
    // Stated stages only: `not-stated` marks a Source's silence, and is not something to prefer.
    stages: z.array(statedStageSchema),
    area: z.string().min(1, "must not be blank"),
    excluded_sectors: z.array(sectorSchema),
  })
  .superRefine((value, ctx) => {
    const excluded = new Set(value.excluded_sectors);
    const overlap = value.sectors.filter((sector) => excluded.has(sector));

    // The database's own check constraint guards this too — see
    // `user_profiles_sectors_excluded_disjoint` in `db/schema.ts` — but the boundary is where
    // this Ticket asks the rejection to name the offending field.
    if (overlap.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["excluded_sectors"],
        message: `cannot list a Sector as both stated and excluded: ${overlap.join(", ")}`,
      });
    }
  });

export type UserProfileInput = z.infer<typeof userProfileInputSchema>;
