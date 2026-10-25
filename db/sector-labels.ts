/**
 * The words a Sector slug reads as, next to `SECTOR_VALUES` in `db/profile-input.ts`.
 *
 * It lives here, apart from `SECTOR_VALUES`, for the same reason `db/not-stated-stage.ts` does:
 * `lib/ui/profile-card.tsx` renders every Sector on the client Deck, and importing it from
 * `db/profile-input.ts` would ship Zod in `/deck`'s bundle, past its performance budget
 * (`e2e/deck-performance.spec.ts`). Nothing may be imported into this file.
 */
export const SECTOR_LABELS = {
  "ai-ml": "AI / ML",
  "developer-tools": "Developer tools",
  "data-infrastructure": "Data infrastructure",
  "saas-enterprise": "Enterprise SaaS",
  fintech: "Fintech",
  "health-bio": "Health & bio",
  security: "Security",
  "hardware-robotics": "Hardware & robotics",
  "climate-energy": "Climate & energy",
  "consumer-marketplace": "Consumer & marketplaces",
  "vertical-saas": "Vertical SaaS",
  other: "Other",
} as const;
