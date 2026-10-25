/**
 * The words a Stage slug reads as, next to `STAGE_VALUES` in `db/profile-input.ts`.
 *
 * It lives here, apart from `STAGE_VALUES`, for the same reason `db/not-stated-stage.ts` does:
 * `lib/ui/profile-card.tsx` renders every Stage on the client Deck, and importing it from
 * `db/profile-input.ts` would ship Zod in `/deck`'s bundle, past its performance budget
 * (`e2e/deck-performance.spec.ts`). Nothing may be imported into this file.
 */
export const STAGE_LABELS = {
  "pre-seed": "Pre-seed",
  seed: "Seed",
  "series-a": "Series A",
  "series-b-plus": "Series B+",
  growth: "Growth",
  "not-stated": "Not stated",
} as const;
