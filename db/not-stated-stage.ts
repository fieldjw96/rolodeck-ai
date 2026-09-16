/**
 * The stage of a Company Profile whose Source neither stated one nor gave us one to derive.
 *
 * It lives here, apart from `STAGE_VALUES` in `db/profile-input.ts`, because
 * `lib/ui/profile-card.tsx` renders it on the client Deck, and importing it from
 * `db/profile-input.ts` would ship Zod in `/deck`'s bundle, past its performance budget
 * (`e2e/deck-performance.spec.ts`). Nothing may be imported into this file.
 */
export const NOT_STATED_STAGE = "not-stated";
